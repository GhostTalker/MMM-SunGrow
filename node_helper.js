/* node_helper.js
 * MagicMirror Module: MMM-SunGrow
 *
 * Features:
 * - Single login & token reuse
 * - Handling of four data requests:
 *    1) DETAILS_DATA
 *    2) CURRENTPOWER_DATA (storage/battery)
 *    3) OVERVIEW_DATA (placeholder)
 *    4) DAY_ENERGY_DATA (placeholder)
 */

const NodeHelper = require("node_helper");
const fetch = require("node-fetch");

module.exports = NodeHelper.create({

  // Variables we'll use:
  start: function () {
    console.log("[MMM-SunGrow] node_helper started...");
    this.config = null;
    this.token = null;           // We'll store the iSolarCloud token here
    this.loginInProgress = false; // Prevent multiple logins at once
  },

  /**
   * MagicMirror will call socketNotificationReceived() whenever
   * the front-end sends a notification. We'll handle:
   * - "SUN_GROW_CONFIG" (initial config)
   * - "MMM-SunGrow-NOTIFICATION_SUNGROW_DETAILS_DATA_REQUESTED"
   * - "MMM-SunGrow-NOTIFICATION_SUNGROW_CURRENTPOWER_DATA_REQUESTED"
   * - "MMM-SunGrow-NOTIFICATION_SUNGROW_OVERVIEW_DATA_REQUESTED"
   * - "MMM-SunGrow-NOTIFICATION_SUNGROW_DAY_ENERGY_DATA_REQUESTED"
   */
  socketNotificationReceived: async function (notification, payload) {
    if (notification === "SUN_GROW_CONFIG") {
      // Save the config
      this.config = payload;
      console.log("[MMM-SunGrow] Received config:", this.config);
      return;
    }

    // Then check which data request we got:
    switch (notification) {

      case "MMM-SunGrow-NOTIFICATION_SUNGROW_DETAILS_DATA_REQUESTED":
        // Ensure we have a valid token, then fetch details
        await this.ensureLogin();
        this.fetchDetailsData();
        break;

      case "MMM-SunGrow-NOTIFICATION_SUNGROW_CURRENTPOWER_DATA_REQUESTED":
        // e.g. battery/storage data
        await this.ensureLogin();
        this.fetchCurrentPowerData();
        break;

      case "MMM-SunGrow-NOTIFICATION_SUNGROW_OVERVIEW_DATA_REQUESTED":
        await this.ensureLogin();
        this.fetchOverviewData();
        break;

      case "MMM-SunGrow-NOTIFICATION_SUNGROW_DAY_ENERGY_DATA_REQUESTED":
        await this.ensureLogin();
        this.fetchDayEnergyData();
        break;
    }
  },

  /**
   * ensureLogin():
   * If we have no token, we attempt a login; if a login is already in progress,
   * we wait until it's finished. This avoids multiple logins at the same time.
   */
  ensureLogin: async function () {
    // If we already have a valid token, do nothing:
    if (this.token) {
      return;
    }

    // If a login is already in progress, wait until it completes
    if (this.loginInProgress) {
      console.log("[MMM-SunGrow] Waiting for ongoing login to finish...");
      while (this.loginInProgress) {
        // Sleep 500ms, then check again
        await new Promise((r) => setTimeout(r, 500));
      }
      return;
    }

    // Otherwise, do a fresh login
    this.loginInProgress = true;
    try {
      await this.loginToISolarCloud();
    } finally {
      this.loginInProgress = false;
    }
  },

  /**
   * loginToISolarCloud():
   * Logs in to iSolarCloud using the config’s user/password, appKey, secretKey, etc.
   * We'll store the token in this.token once done.
   */
  loginToISolarCloud: async function () {
    try {
      if (!this.config) {
        throw new Error("No config found. Did you send SUN_GROW_CONFIG?");
      }
      if (!this.config.userName || !this.config.userPassword) {
        throw new Error("No user/password provided in config for iSolarCloud login.");
      }
      if (!this.config.portalUrl) {
        throw new Error("No portalUrl specified in config.");
      }

      const loginUrl = `${this.config.portalUrl}/openapi/login`;
      const body = {
        appkey: this.config.appKey || "",
        user_account: this.config.userName,
        user_password: this.config.userPassword,
        lang: "_en_US",
        sys_code: "207", // or "901" depending on your environment
        token: ""
      };

      const res = await fetch(loginUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-access-key": this.config.secretKey || ""
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        throw new Error(`Login HTTP error! status: ${res.status}`);
      }

      const loginData = await res.json();
      if (loginData.result_code !== "1") {
        throw new Error(`Login error: ${loginData.result_msg || "Unknown error"}`);
      }

      this.token = loginData.result_data.token;
      console.log("[MMM-SunGrow] /openapi/login success, token:", this.token);

    } catch (error) {
      console.error("[MMM-SunGrow] Error in loginToISolarCloud:", error);
      // We do NOT nullify this.token here, because it might not have been set yet
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  },

  /**
   * fetchDetailsData():
   * Calls /openapi/getPowerStationDetail for "details" data
   * and transforms to the old "details" structure:
   *   { details: { location: { address }, peakPower } }
   */
  fetchDetailsData: async function () {
    if (!this.token) {
      console.warn("[MMM-SunGrow] No token, cannot fetch details data!");
      this.sendSocketNotification("SUN_GROW_ERROR", { message: "No token available." });
      return;
    }

    if (!this.config.plantSN) {
      console.warn("[MMM-SunGrow] No plantSN in config!");
      this.sendSocketNotification("SUN_GROW_ERROR", { message: "No sn in config." });
      return;
    }

    try {
      const url = `${this.config.portalUrl}/openapi/getPowerStationDetail`;
      const body = {
        appkey: this.config.appKey || "",
        is_get_ps_remarks: "1",
        lang: "_en_US",
        sn: this.config.plantSN,
        sys_code: "207",
        token: this.token
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-access-key": this.config.secretKey || ""
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        if (res.status === 401) {
          console.warn("[MMM-SunGrow] Token might have expired. Re-login needed.");
          this.token = null;
          return;
        }
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const json = await res.json();
      if (json.result_code !== "1") {
        throw new Error(`getPowerStationDetail error: ${json.result_msg}`);
      }

      // E.g. { design_capacity, ps_location, ... }
      const rd = json.result_data || {};
      const transformed = {
        details: {
          location: {
            address: rd.ps_location || "No address"
          },
          peakPower: (rd.design_capacity || 0) / 1000
        }
      };

      this.sendSocketNotification(
        "MMM-SunGrow-NOTIFICATION_SUNGROW_DETAILS_DATA_RECEIVED",
        transformed
      );

    } catch (error) {
      console.error("[MMM-SunGrow] fetchDetailsData error:", error);
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  },

  /**
   * fetchStorageData():
   * Calls /openapi/getBatteryMeasuringPoints for battery SoC, status, etc.
   * Maps them to siteCurrentPowerFlow.STORAGE in the old format.
   */
  fetchCurrentPowerData: async function () {
    if (!this.token) {
      console.warn("[MMM-SunGrow] No token, cannot fetch current power data!");
      this.sendSocketNotification("SUN_GROW_ERROR", { message: "No token available." });
      return;
    }

    try {
      const url = `${this.config.portalUrl}/openapi/getDeviceRealTimeData`;
      const body = {
        appkey: this.config.appKey || "",
        device_type: "14",
        lang: "_en_US",
        point_id_list: ["13126", "13150", "13141", "13119","13011"], // SoC, status, voltage, current
        ps_key_list: [ `${this.config.plantId}_14_1_1` ],  // or from config
        sys_code: "207",
        token: this.token
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-access-key": this.config.secretKey || ""
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        if (res.status === 401) {
          console.warn("[MMM-SunGrow] Battery request got 401 => token expired?");
          this.token = null;
          return;
        }
        throw new Error(`Battery data HTTP error! status: ${res.status}`);
      }

      const json = await res.json();
      if (json.result_code !== "1") {
        throw new Error(`Battery data error: ${json.result_msg}`);
      }

      const dp = json.result_data.device_point_list?.[0]?.device_point;
      if (!dp) {
        console.warn("[MMM-SunGrow] No device_point in battery response");
        return;
      }

      // Extract numeric values
      const batteryChargingPower = parseFloat(dp.p13126) || 0;   // Battery Charging
      const batteryDischargingPower = parseFloat(dp.p13150) || 0; // Battery Discharging
      const devStorageChargeLevel = parseFloat(dp.p13141) || 0;   // Battery Charge Level
      const devLoadPowerW = parseFloat(dp.p13119) || 0;   // actual LOAD power
      const devPvPower = parseFloat(dp.p13011) || 0;   // actual PV power


      // Build arrow connections & currentPower
      const connections = [];
      let devStoragePowerW = 0;

      // If chargingPower > 0 => from PV to STORAGE
      if (batteryChargingPower > 0) {
        connections.push({ from: "PV", to: "STORAGE" });
        devStoragePowerW = batteryChargingPower;
      // Else if dischargingPower > 0 => from STORAGE to LOAD
      } else if (batteryDischargingPower > 0) {
        connections.push({ from: "STORAGE", to: "LOAD" });
        devStoragePowerW = batteryDischargingPower;
      // Else both 0 => no arrow, currentPower=0
      }

      if (devPvPower > 0) {
        connections.push({ from: "PV", to: "LOAD" });
      }

      // Now build the final data structure
      const transformed = {
        siteCurrentPowerFlow: {
          STORAGE: { currentPower: devStoragePowerW, status: "Active", chargeLevel: devStorageChargeLevel * 100 },
          PV:   { currentPower: devPvPower, status: "Active" },
          LOAD: { currentPower: devLoadPowerW, status: "Active" },
          GRID: { currentPower: 0, status: "Active" },
          connections: connections,
          unit: "W"
        }
      };

      console.log("[MMM-SunGrow] Current power data:", transformed);
      this.sendSocketNotification(
        "MMM-SunGrow-NOTIFICATION_SUNGROW_CURRENTPOWER_DATA_RECEIVED",
        transformed
      );

    } catch (error) {
      console.error("[MMM-SunGrow] fetchStorageData error:", error);
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  },

  /**
   * fetchOverviewData():
   * A placeholder. Fill in with the actual iSolarCloud endpoint and
   * transform the response as needed, then send "MMM-SunGrow-NOTIFICATION_SUNGROW_OVERVIEW_DATA_RECEIVED".
   */
  fetchOverviewData: async function () {
    if (!this.token) {
      console.warn("[MMM-SunGrow] No token for overview!");
      this.sendSocketNotification("SUN_GROW_ERROR", { message: "No token available." });
      return;
    }
    console.log("[MMM-SunGrow] fetchOverviewData() called - placeholder");

    try {
      // e.g. call "/openapi/overview"
      // For now, dummy data:
      const result = {
        overview: {
          lastDayData: { energy: 5000 },    // 5,000 Wh
          lastMonthData: { energy: 30000 }, // 30,000 Wh
          lastYearData: { energy: 200000 }  // 200 kWh
        }
      };
      this.sendSocketNotification(
        "MMM-SunGrow-NOTIFICATION_SUNGROW_OVERVIEW_DATA_RECEIVED",
        result
      );

    } catch (error) {
      console.error("[MMM-SunGrow] fetchOverviewData error:", error);
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  },

  /**
   * fetchDayEnergyData():
   * Another placeholder for daily energy endpoint. Convert the
   * JSON to the old structure e.g. `dataNotificationDayEnergy.energyDetails`.
   */
  fetchDayEnergyData: async function () {
    if (!this.token) {
      console.warn("[MMM-SunGrow] No token for day energy!");
      this.sendSocketNotification("SUN_GROW_ERROR", { message: "No token available." });
      return;
    }
    console.log("[MMM-SunGrow] fetchDayEnergyData() called - placeholder");

    try {
      // e.g. call "/openapi/getDayEnergy"
      // For now, dummy data:
      const result = {
        energyDetails: {
          meters: [
            { type: "Production", values: [{ value: 4000 }] },
            { type: "Consumption", values: [{ value: 2000 }] },
            { type: "FeedIn", values: [{ value: 1000 }] },
            { type: "Purchased", values: [{ value: 500 }] },
            { type: "SelfConsumption", values: [{ value: 1500 }] }
          ]
        }
      };
      this.sendSocketNotification(
        "MMM-SunGrow-NOTIFICATION_SUNGROW_DAY_ENERGY_DATA_RECEIVED",
        result
      );

    } catch (error) {
      console.error("[MMM-SunGrow] fetchDayEnergyData error:", error);
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  }

});
