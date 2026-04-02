const { ipcMain } = require("electron");
const { detect, detectStlink, detectDaplink, flashFirmware } = require("openocd-tool");

function registerOpenocdHandlers(mainWindow) {
  // 检测所有设备（ST-Link + DAPLink）
  ipcMain.handle("openocd-detect-all", async () => {
    try {
      const devices = await detect();
      console.log("Detected devices:", devices);
      
      return { success: true, devices };
    } catch (error) {
      console.error("openocd detect all devices failed:", error);
      return { success: false, error: error.message };
    }
  });

  // 检测 ST-Link 设备
  ipcMain.handle("openocd-detect-stlink", async () => {
    try {
      const devices = await detectStlink();
      return { success: true, devices };
    } catch (error) {
      console.error("openocd detect stlink failed:", error);
      return { success: false, error: error.message };
    }
  });

  // 检测 DAPLink 设备
  ipcMain.handle("openocd-detect-daplink", async () => {
    try {
      const devices = await detectDaplink();
      return { success: true, devices };
    } catch (error) {
      console.error("openocd detect daplink failed:", error);
      return { success: false, error: error.message };
    }
  });

  // 烧录固件
  ipcMain.handle("openocd-flash", async (event, options) => {
    try {
      const result = await flashFirmware(options);
      return { success: result.success, output: result.output };
    } catch (error) {
      console.error("openocd flash failed:", error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerOpenocdHandlers };
