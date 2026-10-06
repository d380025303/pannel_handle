const MESSAGES = {
  "login-unavailable": ["请先登录 Qoder 桌面 App；若已登录，请重新打开 App 后重试。", "Please sign in to Qoder desktop App, then retry."],
  "login-expired": ["Qoder 桌面 App 登录已过期，请重新登录。", "Qoder desktop login expired. Please sign in again."],
  "device-identity-unavailable": ["无法读取 Qoder 设备身份，请打开 Qoder 桌面 App 完成设备验证后重试。", "Cannot read Qoder device identity. Open Qoder desktop App and complete device verification."],
  "authentication": ["Qoder 登录或设备验证已失效，请打开桌面 App 后重试。", "Qoder login or device verification expired. Open the desktop App and retry."],
  "account-changed": ["Qoder 桌面 App 账号已变化，请刷新额度后重试。", "Qoder desktop account changed. Refresh quota and retry."],
  "network": ["Qoder 请求失败或超时，请稍后重试。", "Qoder request failed or timed out. Please retry."],
  "http-error": ["Qoder 服务暂不可用，请稍后重试。", "Qoder service is unavailable. Please retry."],
  "invalid-response": ["Qoder 返回的数据无法识别，请重试或更新应用。", "Qoder returned unsupported data. Retry or update the application."],
  "response-too-large": ["Qoder 返回的数据过大，请稍后重试。", "Qoder response exceeded the size limit. Please retry."],
  "ambiguous-campaign": ["无法确认当前签到活动，请在 Qoder 桌面 App 中查看。", "Cannot identify the current daily reward. Check Qoder desktop App."],
  "activity-inactive": ["当前签到活动不可领取。", "The daily reward is not available."],
  "window-changed": ["签到周期已变化，请刷新后重试。", "The reward window changed. Refresh and retry."],
  "claim-unconfirmed": ["尚未确认签到成功，请刷新状态，避免重复领取。", "The reward has not been confirmed. Refresh status before retrying."],
  "invalid-account": ["Qoder 账号信息无效，请刷新后重试。", "Invalid Qoder account context. Refresh and retry."],
  "unknown": ["Qoder 签到查询失败，请稍后重试。", "Qoder check-in failed. Please retry."]
};

function toQoderCheckinError(error, locale = "zh-CN") {
  const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : "unknown";
  return { code, message: MESSAGES[code][locale === "en-US" ? 1 : 0], retryable: error?.retryable === true };
}

function registerQoderCheckinIpcHandlers({ ipcMain, service, getLocale = () => "zh-CN" }) {
  for (const [channel, method] of [["qoder-checkin:get-status", "getStatus"], ["qoder-checkin:claim", "claim"]]) {
    ipcMain.handle(channel, async (_event, input) => {
      try {
        const accountId = input?.accountId;
        if (accountId !== undefined && (typeof accountId !== "string" || !accountId.trim() || accountId.length > 240)) {
          throw Object.assign(new Error(), { code: "invalid-account" });
        }
        return { ok: true, value: await service[method](accountId) };
      } catch (error) {
        return { ok: false, error: toQoderCheckinError(error, getLocale()) };
      }
    });
  }
}

module.exports = { registerQoderCheckinIpcHandlers, toQoderCheckinError };
