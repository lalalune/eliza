import { EXTERNAL_URLS } from "@elizaos/shared/brand";
/** Default for i18n copy that uses `{{appName}}` (e.g. "Where should {{appName}} run?"). */
export const DEFAULT_APP_DISPLAY_NAME = "Eliza";
export const DEFAULT_BRANDING = {
    appName: DEFAULT_APP_DISPLAY_NAME,
    orgName: "elizaos",
    repoName: "eliza",
    docsUrl: EXTERNAL_URLS.docs,
    appUrl: EXTERNAL_URLS.app,
    bugReportUrl: "https://github.com/elizaos/eliza/issues/new?template=bug_report.yml",
    hashtag: "#ElizaAgent",
    fileExtension: ".eliza-agent",
    packageScope: "elizaos",
};
/** Pass to `t(key, appNameInterpolationVars(branding))` when the string contains `{{appName}}`. */
export function appNameInterpolationVars(branding) {
    const name = branding.appName?.trim();
    return { appName: name || DEFAULT_APP_DISPLAY_NAME };
}
