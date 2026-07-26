const DICT = {
  "common.save": "Save",
  "common.saved": "Saved",
  "common.saving": "Saving",
  "common.disable": "Disable",
  "secretsview.Required": "Required",
};
const t = (key, vars = {}) => {
  const template = String(vars.defaultValue ?? DICT[key] ?? key);
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole
  );
};
const appValue = {
  t,
  elizaCloudConnected: true,
  setActionNotice: () => {},
  loadPlugins: async () => {},
};
export function useAppSelector(selector) {
  return selector(appValue);
}
export function useAppSelectorShallow(selector) {
  return selector(appValue);
}
export function useTranslation() {
  return { t, uiLanguage: "en", setUiLanguage: () => {} };
}
