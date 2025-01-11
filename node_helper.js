/* node_helper.js
 * MagicMirror Module: MMM-SunGrow
 *
 * This node_helper:
 * 1) Logs into iSolarCloud on demand
 * 2) Handles requests for:
 *    - DETAILS   (fetchDetailsData)
 *    - CURRENT POWER/BATTERY (fetchStorageData)
 *    - OVERVIEW (fetchOverviewData) - placeholder
 *    - DAY ENERGY (fetchDayEnergyData) - placeholder
 */

const NodeHelper = require("node_helper");
const fetch = require("node-fetch");

module.exports = NodeHelper.create({

  // 1) Initialize
  start: function () {
    console.log("[MMM-SunGrow] node_helper started...");
    this.config = null;
    this.token = null; // We'll store the iSolarCloud token here
  },

  // 2) Handle incoming notifications from MMM-SunGrow.js
  socketNotificationReceived: async function (notification, payload) {
    if (notification === "SUN_GROW_CONFIG") {
      this.config = payload;
      console.log("[MMM-SunGrow] Received config:", this.config);

      // If we have no token yet, do an initial login
      if (!this.token) {
        await this.loginToISolarCloud();
      }
      return;
    }

    // Listen for data requests from the front-end
    switch (notification) {

      case "MMM-SunGrow-NOTIFICATION_SUNGROW_DETAILS_DATA_REQUESTED":
        if (!this.token) {
          await this.loginToISolarCloud();
        }
        this.fetchDetailsData();
        break;

      case "MMM-SunGrow-NOTIFICATION_SUNGROW_CURRENTPOWER_DATA_REQUESTED":
        if (!this.token) {
          await this.loginToISolarCloud();
        }
        this.fetchStorageData();
        break;

      case "MMM-SunGrow-NOTIFICATION_SUNGROW_OVERVIEW_DATA_REQUESTED":
        if (!this.token) {
          await this.loginToISolarCloud();
        }
        this.fetchOverviewData(); // placeholder below
        break;

      case "MMM-SunGrow-NOTIFICATION_SUNGROW_DAY_ENERGY_DATA_REQUESTED":
        if (!this.token) {
          await this.loginToISolarCloud();
        }
        this.fetchDayEnergyData(); // placeholder below
        break;
    }
  },

  // 3) Login method for iSolarCloud
  loginToISolarCloud: async function () {
    try {
      if (!this.config.userName || !this.config.userPassword) {
        throw new Error("No user/password provided in config for iSolarCloud login.");
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
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  },

  // 4) DETAILS (Plant Info) - /openapi/getPowerStationDetail
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
        sn: this.config.plantSN, // e.g. "B22C2803603"
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
          await this.loginToISolarCloud();
          return;
        }
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const json = await res.json();
      if (json.result_code !== "1") {
        throw new Error(`getPowerStationDetail error: ${json.result_msg}`);
      }

      // Transform the result to old "details" structure
      const rd = json.result_data;
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

  // 5) CURRENT POWER (Battery/Storage Info) - /openapi/getBatteryMeasuringPoints
  fetchStorageData: async function () {
    if (!this.token) {
      console.warn("[MMM-SunGrow] No token, cannot fetch storage data!");
      this.sendSocketNotification("SUN_GROW_ERROR", { message: "No token available." });
      return;
    }

    try {
      const url = `${this.config.portalUrl}/openapi/getBatteryMeasuringPoints`;
      const body = {
        appkey: this.config.appKey || "",
        device_type: "43",
        lang: "_en_US",
        point_id_list: ["58604", "58608", "58601", "58602"],
        ps_key_list: [ "5326778_43_2_1" ],  // or read from config
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
          console.warn("[MMM-SunGrow] Storage request 401 => token expired?");
          this.token = null;
          await this.loginToISolarCloud();
          return;
        }
        throw new Error(`Battery data HTTP error! status: ${res.status}`);
      }

      const json = await res.json();
      if (json.result_code !== "1") {
        throw new Error(`Battery data error: ${json.result_msg}`);
      }

      // device_point includes p58604 (SoC fraction), p58608 (status code), p58601 (voltage), p58602 (amp)
      const dp = json.result_data.device_point_list?.[0]?.device_point;
      if (!dp) {
        console.warn("[MMM-SunGrow] No device_point in battery response");
        return;
      }

      // Convert string fields to floats or handle as needed
      const socFraction = parseFloat(dp.p58604) || 0;
      const voltage = parseFloat(dp.p58601) || 0;
      const current = parseFloat(dp.p58602) || 0;
      const statusCode = dp.p58608 || "0";

      let statusText;
      const connections = [];

      // 1 = Charging, 2 = Discharging, 0 = Idle
      switch (statusCode) {
        case "1":
          statusText = "Charging";
          connections.push({ from: "LOAD", to: "STORAGE" });
          break;
        case "2":
          statusText = "Discharging";
          connections.push({ from: "STORAGE", to: "LOAD" });
          break;
        case "0":
          statusText = "Idle";
          break;
        default:
          statusText = `Unknown(${statusCode})`;
      }

      // Approx power in watts
      const powerW = voltage * current;

      // Build old structure
      const transformed = {
        siteCurrentPowerFlow: {
          STORAGE: {
            currentPower: powerW,
            status: statusText,
            chargeLevel: socFraction * 100
          },
          PV:   { currentPower: 0, status: "Unknown" },
          LOAD: { currentPower: 0, status: "Unknown" },
          GRID: { currentPower: 0, status: "Unknown" },
          connections: connections,
          unit: "W"
        }
      };

      console.log("[MMM-SunGrow] Storage data:", transformed);

      this.sendSocketNotification(
        "MMM-SunGrow-NOTIFICATION_SUNGROW_CURRENTPOWER_DATA_RECEIVED",
        transformed
      );

    } catch (error) {
      console.error("[MMM-SunGrow] fetchStorageData error:", error);
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  },

  // 6) Overview (Placeholder Example)
  fetchOverviewData: async function () {
    if (!this.token) {
      console.warn("[MMM-SunGrow] No token for overview!");
      this.sendSocketNotification("SUN_GROW_ERROR", { message: "No token available." });
      return;
    }

    try {
      // 1) Call your iSolarCloud endpoint for overview
      //    e.g., `${this.config.portalUrl}/openapi/getOverviewData`
      //    We'll do a placeholder:
      console.log("[MMM-SunGrow] fetchOverviewData() called - placeholder");

      // For example:
      const result = {
        overview: {
          // fill with data from the real endpoint
          lastDayData: { energy: 5000 },   // e.g. 5,000 Wh => 5 kWh
          lastMonthData: { energy: 30000 }, // 30 kWh
          lastYearData: { energy: 200000 }  // 200 kWh
        }
      };

      // Transform or just pass it as-is:
      // The old code expects dataNotificationOverview.overview in the front-end
      this.sendSocketNotification(
        "MMM-SunGrow-NOTIFICATION_SUNGROW_OVERVIEW_DATA_RECEIVED",
        result
      );

    } catch (error) {
      console.error("[MMM-SunGrow] fetchOverviewData error:", error);
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  },

  // 7) Day Energy (Placeholder Example)
  fetchDayEnergyData: async function () {
    if (!this.token) {
      console.warn("[MMM-SunGrow] No token for day energy!");
      this.sendSocketNotification("SUN_GROW_ERROR", { message: "No token available." });
      return;
    }

    try {
      // 1) Call your iSolarCloud endpoint for day energy
      console.log("[MMM-SunGrow] fetchDayEnergyData() called - placeholder");

      // Example placeholder:
      const result = {
        energyDetails: {
          meters: [
            { type: "Production", values: [{ value: 4000 }] },     // 4,000 Wh => 4 kWh
            { type: "Consumption", values: [{ value: 2000 }] },   // 2,000 Wh => 2 kWh
            { type: "FeedIn", values: [{ value: 1000 }] },        // 1,000 Wh
            { type: "Purchased", values: [{ value: 500 }] },      // 500 Wh
            { type: "SelfConsumption", values: [{ value: 1500 }] }// 1,500 Wh
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
