/**
 * ElizaClient extension (declaration-merged) for the automations feed: list
 * workflows and fetch the node catalog.
 */
import { ElizaClient } from "./client-base";
ElizaClient.prototype.listAutomations = async function () {
    return this.fetch("/api/automations");
};
ElizaClient.prototype.getAutomationNodeCatalog = async function () {
    return this.fetch("/api/automations/nodes");
};
