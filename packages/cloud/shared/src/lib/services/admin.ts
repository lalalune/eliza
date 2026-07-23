/**
 * Admin Service
 *
 * Manages admin users and moderation capabilities.
 * Default anvil wallet is auto-admin in devnet (not production).
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../../db/client";
import { apiKeysRepository } from "../../db/repositories";
import {
  type AdminUser,
  adminUsers,
  type ModerationViolation,
  moderationViolations,
  type UserModerationStatus,
  userModerationStatus,
  users,
} from "../../db/schemas";
import { shouldBlockDevnetBypass } from "../config/deployment-environment";
import { logger } from "../utils/logger";
import { invalidateInferenceAuthContextsByKeyHashes } from "./inference-auth-cache";
import { applyInferenceAuthorizationState } from "./inference-authorization-boundary";
import { moderationAuthorizationState } from "./inference-authorization-lifecycle";

/**
 * Clear the inference auth-context cache (#9899) for every API key a user owns.
 * Called on ban so a user who was being served from a warm IAC entry stops
 * fast-pathing inference immediately (bounded otherwise by the IAC TTL).
 */
async function invalidateUserInferenceContext(userId: string): Promise<void> {
  const keys = await apiKeysRepository.listByUser(userId);
  await invalidateInferenceAuthContextsByKeyHashes(keys.map((k) => k.key_hash));
}

// Default anvil wallet - admin in devnet only
const ANVIL_DEFAULT_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Check if we're in development/devnet mode
function isDevnet(): boolean {
  return process.env.NODE_ENV === "development" || process.env.DEVNET === "true";
}

// CRITICAL: Startup validation to prevent production misconfiguration
// The anvil wallet bypass (lines 42-47) would grant admin access to a well-known
// public key if DEVNET=true in production. This check fails fast at module load.
if (shouldBlockDevnetBypass(process.env)) {
  throw new Error(
    "FATAL: NODE_ENV=production cannot be used with DEVNET=true. " +
      "The anvil wallet admin bypass would expose production to unauthorized access. " +
      "Remove DEVNET=true from production environment variables.",
  );
}

type AdminRole = "super_admin" | "moderator" | "viewer";
type ModerationStatus = "clean" | "warned" | "spammer" | "scammer" | "banned";
type ModerationAction = "refused" | "warned" | "flagged_for_ban" | "banned";

const ELIZALABS_ADMIN_EMAIL_DOMAIN = "@elizalabs.ai";

interface AdminIdentity {
  email?: string | null;
  email_verified?: boolean | null;
  wallet_address?: string | null;
}

export function isElizaLabsAdminEmail(email?: string | null): boolean {
  return Boolean(email?.trim().toLowerCase().endsWith(ELIZALABS_ADMIN_EMAIL_DOMAIN));
}

class AdminService {
  /**
   * Check if a wallet address is an admin
   */
  async isAdmin(walletAddress: string): Promise<boolean> {
    // In devnet, the default anvil wallet is always admin
    if (isDevnet() && walletAddress.toLowerCase() === ANVIL_DEFAULT_WALLET.toLowerCase()) {
      return true;
    }

    const admin = await dbRead.query.adminUsers.findFirst({
      where: and(
        eq(adminUsers.walletAddress, walletAddress.toLowerCase()),
        eq(adminUsers.isActive, true),
      ),
    });

    return !!admin;
  }

  /**
   * Check if a user ID is an admin (via their wallet address)
   */
  async isUserAdmin(userId: string): Promise<boolean> {
    const user = await dbRead.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      return false;
    }

    const status = await this.getAdminStatusForUser(user);
    return status.isAdmin;
  }

  /**
   * Get admin status from a full authenticated user record.
   *
   * Any Steward-authenticated @elizalabs.ai account is a super_admin. This
   * keeps Google workspace admins working even when the user has not linked a
   * wallet, while preserving wallet-admin records for non-ElizaLabs users.
   */
  async getAdminStatusForUser(
    user: AdminIdentity,
  ): Promise<{ isAdmin: boolean; role: AdminRole | null }> {
    // SECURITY: the @elizalabs.ai super_admin grant requires a VERIFIED email.
    // Real admins arrive via Steward Google-Workspace SSO, which sets
    // email_verified=true. Without this check, any user could set an UNVERIFIED
    // @elizalabs.ai email (e.g. a free wallet account via PATCH /api/v1/user/email)
    // and self-grant platform super_admin.
    if (isElizaLabsAdminEmail(user.email) && user.email_verified === true) {
      return { isAdmin: true, role: "super_admin" };
    }

    if (!user.wallet_address) {
      return { isAdmin: false, role: null };
    }

    return this.getAdminStatus(user.wallet_address);
  }

  /**
   * Get admin role for a wallet address
   */
  async getAdminRole(walletAddress: string): Promise<AdminRole | null> {
    // In devnet, the default anvil wallet is super_admin
    if (isDevnet() && walletAddress.toLowerCase() === ANVIL_DEFAULT_WALLET.toLowerCase()) {
      return "super_admin";
    }

    const admin = await dbRead.query.adminUsers.findFirst({
      where: and(
        eq(adminUsers.walletAddress, walletAddress.toLowerCase()),
        eq(adminUsers.isActive, true),
      ),
    });

    return admin?.role ?? null;
  }

  /**
   * Get admin status + role for a wallet address in a single query.
   */
  async getAdminStatus(
    walletAddress: string,
  ): Promise<{ isAdmin: boolean; role: AdminRole | null }> {
    // In devnet, the default anvil wallet is super_admin
    if (isDevnet() && walletAddress.toLowerCase() === ANVIL_DEFAULT_WALLET.toLowerCase()) {
      return { isAdmin: true, role: "super_admin" };
    }

    const admin = await dbRead.query.adminUsers.findFirst({
      where: and(
        eq(adminUsers.walletAddress, walletAddress.toLowerCase()),
        eq(adminUsers.isActive, true),
      ),
    });

    return { isAdmin: !!admin, role: admin?.role ?? null };
  }

  /**
   * Promote a wallet address to admin
   */
  async promoteToAdmin(params: {
    walletAddress: string;
    role?: AdminRole;
    grantedByWallet?: string;
    notes?: string;
  }): Promise<AdminUser> {
    const { walletAddress, role = "moderator", grantedByWallet, notes } = params;

    // Check if already admin
    const existing = await dbRead.query.adminUsers.findFirst({
      where: eq(adminUsers.walletAddress, walletAddress.toLowerCase()),
    });

    if (existing) {
      // Reactivate if was revoked
      if (!existing.isActive) {
        const [updated] = await dbWrite
          .update(adminUsers)
          .set({
            isActive: true,
            role,
            revokedAt: null,
            updatedAt: new Date(),
            notes: notes ?? existing.notes,
          })
          .where(eq(adminUsers.id, existing.id))
          .returning();

        logger.info("[Admin] Reactivated admin", { walletAddress, role });
        return updated;
      }

      // Update role if different
      if (existing.role !== role) {
        const [updated] = await dbWrite
          .update(adminUsers)
          .set({ role, updatedAt: new Date() })
          .where(eq(adminUsers.id, existing.id))
          .returning();

        logger.info("[Admin] Updated admin role", { walletAddress, role });
        return updated;
      }

      return existing;
    }

    // Find user ID if they've already signed up
    const user = await dbRead.query.users.findFirst({
      where: eq(users.wallet_address, walletAddress.toLowerCase()),
    });

    const [admin] = await dbWrite
      .insert(adminUsers)
      .values({
        walletAddress: walletAddress.toLowerCase(),
        userId: user?.id,
        role,
        grantedByWallet: grantedByWallet?.toLowerCase(),
        notes,
      })
      .returning();

    logger.info("[Admin] Promoted to admin", {
      walletAddress,
      role,
      userId: user?.id,
    });
    return admin;
  }

  /**
   * Revoke admin privileges
   */
  async revokeAdmin(walletAddress: string, revokedByWallet?: string): Promise<void> {
    await dbWrite
      .update(adminUsers)
      .set({
        isActive: false,
        revokedAt: new Date(),
        updatedAt: new Date(),
        notes: revokedByWallet ? `Revoked by ${revokedByWallet}` : "Revoked",
      })
      .where(eq(adminUsers.walletAddress, walletAddress.toLowerCase()));

    logger.info("[Admin] Revoked admin", { walletAddress, revokedByWallet });
  }

  /**
   * List all admins
   */
  async listAdmins(): Promise<AdminUser[]> {
    const admins = await dbRead.query.adminUsers.findMany({
      where: eq(adminUsers.isActive, true),
      orderBy: [desc(adminUsers.createdAt)],
    });

    // In devnet, include the anvil wallet if not already in list
    if (isDevnet()) {
      const hasAnvil = admins.some(
        (a) => a.walletAddress.toLowerCase() === ANVIL_DEFAULT_WALLET.toLowerCase(),
      );

      if (!hasAnvil) {
        return [
          {
            id: "anvil-default",
            walletAddress: ANVIL_DEFAULT_WALLET.toLowerCase(),
            role: "super_admin",
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            userId: null,
            grantedBy: null,
            grantedByWallet: "system",
            notes: "Default anvil wallet (devnet only)",
            revokedAt: null,
          },
          ...admins,
        ];
      }
    }

    return admins;
  }

  // ===== Moderation Functions =====

  /**
   * Record a moderation violation
   */
  async recordViolation(params: {
    userId: string;
    roomId?: string;
    messageText: string;
    categories: string[];
    scores: Record<string, number>;
    action: ModerationAction;
  }): Promise<ModerationViolation> {
    const { userId, roomId, messageText, categories, scores, action } = params;

    // Record violation
    const [violation] = await dbWrite
      .insert(moderationViolations)
      .values({
        userId,
        roomId,
        messageText: messageText.slice(0, 500),
        categories,
        scores,
        action,
      })
      .returning();

    // Update user moderation status
    await this.updateUserModerationStatus(userId, action);

    logger.warn("[Admin] Recorded moderation violation", {
      userId,
      categories,
      action,
    });

    return violation;
  }

  /**
   * Update user moderation status based on violations
   */
  private async updateUserModerationStatus(
    userId: string,
    action: ModerationAction,
  ): Promise<void> {
    const now = new Date();
    const crossedBlockingBoundary = await dbWrite.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(userModerationStatus)
        .where(eq(userModerationStatus.userId, userId))
        .for("update");
      if (!existing) {
        await tx.insert(userModerationStatus).values({
          userId,
          status: "clean",
          totalViolations: 1,
          warningCount: action === "warned" || action === "flagged_for_ban" ? 1 : 0,
          riskScore: 20,
          lastViolationAt: now,
          lastWarningAt: action === "warned" ? now : null,
        });
        return false;
      }

      const newTotalViolations = existing.totalViolations + 1;
      const newWarningCount =
        action === "warned" || action === "flagged_for_ban"
          ? existing.warningCount + 1
          : existing.warningCount;
      const newRiskScore = Math.min(100, existing.riskScore + 20);
      let newStatus: ModerationStatus = existing.status;
      if (newTotalViolations >= 5 && existing.status === "clean") {
        newStatus = "warned";
      }
      await tx
        .update(userModerationStatus)
        .set({
          totalViolations: newTotalViolations,
          warningCount: newWarningCount,
          riskScore: newRiskScore,
          status: newStatus,
          lastViolationAt: now,
          lastWarningAt: action === "warned" ? now : existing.lastWarningAt,
          updatedAt: now,
        })
        .where(eq(userModerationStatus.userId, userId));

      const wasBlocking = existing.status === "banned" || existing.totalViolations >= 5;
      const isBlocking = newStatus === "banned" || newTotalViolations >= 5;
      if (!isBlocking || wasBlocking) return false;

      const [revisionedUser] = await tx
        .update(users)
        .set({
          inference_auth_revision: sql`${users.inference_auth_revision} + 1`,
          updated_at: now,
        })
        .where(eq(users.id, userId))
        .returning();
      if (!revisionedUser?.organization_id) {
        throw new Error(`User ${userId} has no inference organization`);
      }
      await applyInferenceAuthorizationState(
        revisionedUser.organization_id,
        moderationAuthorizationState(revisionedUser, true),
      );
      return true;
    });
    if (crossedBlockingBoundary) {
      await invalidateUserInferenceContext(userId);
    }
  }

  /**
   * Get user moderation status
   */
  async getUserModerationStatus(userId: string): Promise<UserModerationStatus | null> {
    const result = await dbRead.query.userModerationStatus.findFirst({
      where: eq(userModerationStatus.userId, userId),
    });
    return result ?? null;
  }

  /**
   * Check if user is banned
   */
  async isUserBanned(userId: string): Promise<boolean> {
    const status = await this.getUserModerationStatus(userId);
    return status?.status === "banned";
  }

  /**
   * Check if user should be blocked (banned or too many violations)
   */
  async shouldBlockUser(userId: string): Promise<boolean> {
    const status = await this.getUserModerationStatus(userId);
    if (!status) return false;

    return status.status === "banned" || status.totalViolations >= 5;
  }

  /**
   * Mark user as spammer/scammer
   */
  async markUserAs(params: {
    userId: string;
    status: "spammer" | "scammer";
    adminUserId: string;
    reason?: string;
  }): Promise<void> {
    const { userId, status, adminUserId, reason } = params;

    await dbWrite
      .update(userModerationStatus)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(eq(userModerationStatus.userId, userId));

    // Also insert a record if it doesn't exist
    const existing = await this.getUserModerationStatus(userId);
    if (!existing) {
      await dbWrite.insert(userModerationStatus).values({
        userId,
        status,
        totalViolations: 0,
        warningCount: 0,
        riskScore: status === "scammer" ? 100 : 80,
      });
    }

    logger.warn("[Admin] User marked as", {
      userId,
      status,
      adminUserId,
      reason,
    });
  }

  /**
   * Ban a user
   */
  async banUser(params: { userId: string; adminUserId: string; reason: string }): Promise<void> {
    const { userId, adminUserId, reason } = params;
    const now = new Date();
    await dbWrite.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
      if (!user?.organization_id) {
        throw new Error(`User ${userId} has no inference organization`);
      }
      const existing = await tx.query.userModerationStatus.findFirst({
        where: eq(userModerationStatus.userId, userId),
      });
      if (existing) {
        await tx
          .update(userModerationStatus)
          .set({
            status: "banned",
            bannedBy: adminUserId,
            bannedAt: now,
            banReason: reason,
            riskScore: 100,
            updatedAt: now,
          })
          .where(eq(userModerationStatus.userId, userId));
      } else {
        await tx.insert(userModerationStatus).values({
          userId,
          status: "banned",
          totalViolations: 0,
          warningCount: 0,
          riskScore: 100,
          bannedBy: adminUserId,
          bannedAt: now,
          banReason: reason,
        });
      }
      const [revisionedUser] = await tx
        .update(users)
        .set({
          inference_auth_revision: sql`${users.inference_auth_revision} + 1`,
          updated_at: now,
        })
        .where(eq(users.id, userId))
        .returning();
      if (!revisionedUser) {
        throw new Error(`User ${userId} disappeared during ban`);
      }
      await applyInferenceAuthorizationState(
        user.organization_id,
        moderationAuthorizationState(revisionedUser, true),
      );
    });

    // Stop any warm inference fast path for this user immediately (#9899).
    await invalidateUserInferenceContext(userId);

    logger.warn("[Admin] User banned", { userId, adminUserId, reason });
  }

  /**
   * Unban a user
   */
  async unbanUser(userId: string, adminUserId: string): Promise<void> {
    const revisionedUser = await dbWrite.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
      if (!user?.organization_id) {
        throw new Error(`User ${userId} has no inference organization`);
      }
      await tx
        .update(userModerationStatus)
        .set({
          status: "clean",
          bannedBy: null,
          bannedAt: null,
          banReason: null,
          riskScore: 0,
          totalViolations: 0,
          warningCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(userModerationStatus.userId, userId));
      const [updated] = await tx
        .update(users)
        .set({
          inference_auth_revision: sql`${users.inference_auth_revision} + 1`,
          updated_at: new Date(),
        })
        .where(eq(users.id, userId))
        .returning();
      if (!updated) {
        throw new Error(`User ${userId} disappeared during unban`);
      }
      return updated;
    });
    if (!revisionedUser.organization_id) {
      throw new Error(`User ${userId} has no inference organization`);
    }
    await applyInferenceAuthorizationState(
      revisionedUser.organization_id,
      moderationAuthorizationState(revisionedUser, false),
    );

    logger.info("[Admin] User unbanned", { userId, adminUserId });
  }

  /**
   * Get recent violations
   */
  async getRecentViolations(limit = 100): Promise<ModerationViolation[]> {
    return dbRead.query.moderationViolations.findMany({
      orderBy: [desc(moderationViolations.createdAt)],
      limit,
    });
  }

  /**
   * Get violations for a specific user
   */
  async getUserViolations(userId: string): Promise<ModerationViolation[]> {
    return dbRead.query.moderationViolations.findMany({
      where: eq(moderationViolations.userId, userId),
      orderBy: [desc(moderationViolations.createdAt)],
    });
  }

  /**
   * Get users flagged for review (high risk or many violations)
   */
  async getUsersFlaggedForReview(): Promise<UserModerationStatus[]> {
    return dbRead.query.userModerationStatus.findMany({
      where: sql`${userModerationStatus.totalViolations} >= 3 OR ${userModerationStatus.riskScore} >= 60`,
      orderBy: [desc(userModerationStatus.riskScore)],
    });
  }

  /**
   * Get banned users
   */
  async getBannedUsers(): Promise<UserModerationStatus[]> {
    return dbRead.query.userModerationStatus.findMany({
      where: eq(userModerationStatus.status, "banned"),
      orderBy: [desc(userModerationStatus.bannedAt)],
    });
  }

  /**
   * Get user details for admin view
   */
  async getUserDetails(userId: string): Promise<{
    user: typeof users.$inferSelect | null;
    moderationStatus: UserModerationStatus | null;
    violations: ModerationViolation[];
    generationsCount: number;
  }> {
    const [user, moderationStatusResult, violations, generationsResult] = await Promise.all([
      dbRead.query.users.findFirst({ where: eq(users.id, userId) }),
      this.getUserModerationStatus(userId),
      this.getUserViolations(userId),
      dbRead.execute<{ count: string }>(
        sql`SELECT COUNT(*) as count FROM generations WHERE user_id = ${userId}::uuid`,
      ),
    ]);

    return {
      user: user ?? null,
      moderationStatus: moderationStatusResult,
      violations,
      generationsCount: parseInt(generationsResult.rows[0]?.count ?? "0"),
    };
  }
}

export const adminService = new AdminService();
