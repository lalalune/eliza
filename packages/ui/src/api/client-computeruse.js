/**
 * ElizaClient extension and wire types for computer-use: approval modes, pending
 * approvals, and the verbs that resolve them.
 */
import { ElizaClient } from "./client-base";
ElizaClient.prototype.getComputerUseApprovals = async function () {
    return this.fetch("/api/computer-use/approvals");
};
ElizaClient.prototype.respondToComputerUseApproval = async function (id, approved, reason) {
    return this.fetch(`/api/computer-use/approvals/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ approved, reason }),
    });
};
ElizaClient.prototype.setComputerUseApprovalMode = async function (mode) {
    return this.fetch("/api/computer-use/approval-mode", {
        method: "POST",
        body: JSON.stringify({ mode }),
    });
};
