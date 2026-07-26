/**
 * Re-exports the shared platform-managed container detector so Cloud routes and
 * the host authorization boundary cannot drift on provisioning semantics.
 */
export { isCloudProvisionedContainer } from "@elizaos/shared";
