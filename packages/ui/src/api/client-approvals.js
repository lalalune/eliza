import { ElizaClient } from "./client-base";
ElizaClient.prototype.listPendingActions = async function () {
    return this.fetch("/api/approvals");
};
