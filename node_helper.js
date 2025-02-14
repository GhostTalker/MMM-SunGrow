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
      // DEBUG
      // console.log("[MMM-SunGrow] Received config:", this.config);
      console.log("[MMM-SunGrow] Received config successfully");
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
      //DEGBUG
      //console.log("[MMM-SunGrow] /openapi/login success, token:", this.token);
      console.log("[MMM-SunGrow] /openapi/login success");

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
   * fetchCurrentPowerData():
   * Calls /openapi/getDeviceRealTimeData for current power data
   */
  fetchCurrentPowerData: async function () {
    if (!this.token) {
      console.warn("[MMM-SunGrow] No token, cannot fetch current power data!");
      this.sendSocketNotification("SUN_GROW_ERROR", { message: "No token available." });
      return;
    }

    try {
        console.log("[MMM-SunGrow] fetchCurrentPowerData() - calling fetchCurrentPowerData for live stats");

        const url = `${this.config.portalUrl}/openapi/getDeviceRealTimeData`;

        // We request measuring points for:
        //   - 13126: Battery Charging Power
        //   - 13150: Battery Discharging Power
        //   - 13141: Battery Level (SOC)
        //   - 13119: Load Power
        //   - 13011: PV Active Power
        //   - 13121: Feed-in Power
        //   - 13149: Purchased Power
        const body = {
          appkey: this.config.appKey || "",
          device_type: "14",
          lang: "_en_US",
          point_id_list: [
            "13126", // batteryChargingPower
            "13150", // batteryDischargingPower
            "13141", // batterySoC
            "13119", // loadPower
            "13011", // pvPower
            "13121", // feedInPower
            "13149"  // purchasedPower
          ],
          // Construct ps_key_list dynamically from config.plantId
          ps_key_list: [ `${this.config.plantId}_14_1_1` ],
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

      // 1) Battery charging/discharging
      const batteryChargingPower = parseFloat(dp.p13126) || 0;
      const batteryDischargingPower = parseFloat(dp.p13150) || 0;
      const batterySoCFrac = parseFloat(dp.p13141) || 0;
      const batterySoCPercent = batterySoCFrac * 100;
      // 2) Load Power
      const loadPowerW = parseFloat(dp.p13119) || 0;
      // 3) PV Power
      const pvPowerW = parseFloat(dp.p13011) || 0;
      // 4) Grid (FeedIn vs. Purchased)
      const feedInPower = parseFloat(dp.p13121) || 0;
      const purchasedPower = parseFloat(dp.p13149) || 0;
      // Net grid power = feedIn - purchased
      let netGridPower = feedInPower - purchasedPower;
      let gridPowerW = 0; // the final value we store in transformed, always >= 0


      // Build arrow connections & currentPower
      const connections = [];
      let batteryPowerW = 0;

      // If chargingPower > 0 => from PV to STORAGE
      if (batteryChargingPower > 0) {
        connections.push({ from: "PV", to: "STORAGE" });
        batteryPowerW = batteryChargingPower;
      // Else if dischargingPower > 0 => from STORAGE to LOAD
      } else if (batteryDischargingPower > 0) {
        connections.push({ from: "STORAGE", to: "LOAD" });
        batteryPowerW = batteryDischargingPower;
      // Else both 0 => no arrow, currentPower=0
      }

      if (pvPowerW > 0) {
         connections.push({ from: "PV", to: "LOAD" });
      }

      if (netGridPower > 0) {
        // positive => net feed-in => arrow from "PV" to "GRID"
        connections.push({ from: "LOAD", to: "GRID" });
        gridPowerW = netGridPower;     // show as positive
      } else if (netGridPower < 0) {
        // negative => net purchase => arrow from "GRID" to "LOAD"
        connections.push({ from: "GRID", to: "LOAD" });
        gridPowerW = -netGridPower;    // make it positive for display
      } else {
        // zero => no arrow, gridPowerW = 0
      }


      // Build final structure
      const transformed = {
        siteCurrentPowerFlow: {
          STORAGE: { currentPower: batteryPowerW, status: "Active", chargeLevel: batterySoCPercent },
          PV:      { currentPower: pvPowerW,      status: "Active" },
          LOAD:    { currentPower: loadPowerW,    status: "Active" },
          GRID:    { currentPower: gridPowerW,    status: "Active" },
          connections: connections,
          unit: "W"
        }
      };

      // DEBUGGING:
      // console.log("[MMM-SunGrow] Current power data:", transformed);
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
   * fetchDayEnergyData():
   * Calls /openapi/getDeviceRealTimeData with the measuring points for daily data:
   *  - 13112 = daily PV Production (Wh)
   *  - 13199 = daily Load Consumption (Wh)
   *  - 13122 = daily Feed-In (Wh)
   *  - 13147 = daily Purchased (Wh)
   *  - 13116 = daily Direct Energy Consumption / self-consumption (Wh)
   *
   * Then transforms to:
   *  {
   *    energyDetails: {
   *      meters: [
   *        { type: "Production",   values: [{ value: ... }] },
   *        { type: "Consumption",  values: [{ value: ... }] },
   *        { type: "FeedIn",       values: [{ value: ... }] },
   *        { type: "Purchased",    values: [{ value: ... }] },
   *        { type: "SelfConsumption", values: [{ value: ... }] }
   *      ]
   *    }
   *  }
   */
  fetchDayEnergyData: async function () {
    if (!this.token) {
      console.warn("[MMM-SunGrow] No token for day energy!");
      this.sendSocketNotification("SUN_GROW_ERROR", { message: "No token available." });
      return;
    }

    try {
      console.log("[MMM-SunGrow] fetchDayEnergyData() - calling getDeviceRealTimeData for daily stats");

      // 1) We call /openapi/getDeviceRealTimeData with the measuring points needed:
      //    - 13112 = daily PV Production (Wh)
      //    - 13199 = daily Load Consumption (Wh)
      //    - 13122 = daily Feed-In Energy Today (Wh)
      //    - 13147 = daily Purchased Energy Today (Wh)
      //    - 13116 = daily Direct Energy Consumption (aka self consumption) (Wh)
      const url = `${this.config.portalUrl}/openapi/getDeviceRealTimeData`;
      const body = {
        appkey: this.config.appKey || "",
        device_type: "14",
        lang: "_en_US",
        point_id_list: [
          "13112", // daily PV Production
          "13199", // daily Load Consumption
          "13122", // daily Feed-In
          "13147", // daily Purchased
          "13116"  // daily Self Consumption
        ],
        ps_key_list: [ `${this.config.plantId}_14_1_1` ],
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
          console.warn("[MMM-SunGrow] Day energy request got 401 => token expired?");
          this.token = null;
          return;
        }
        throw new Error(`DayEnergy HTTP error! status: ${res.status}`);
      }

      const json = await res.json();
      if (json.result_code !== "1") {
        throw new Error(`DayEnergy data error: ${json.result_msg}`);
      }

      // 2) Extract the device_point
      const dp = json.result_data.device_point_list?.[0]?.device_point;
      if (!dp) {
        console.warn("[MMM-SunGrow] No device_point in day energy response");
        return;
      }

      // 3) Convert the measuring points to floats, defaulting to 0 if missing
      const dailyProductionWh = parseFloat(dp.p13112) || 0;  // daily PV Production
      const dailyConsumptionWh = parseFloat(dp.p13199) || 0; // daily Load Consumption
      const dailyFeedInWh = parseFloat(dp.p13122) || 0;      // daily Feed-in
      const dailyPurchasedWh = parseFloat(dp.p13147) || 0;   // daily Purchased
      const dailySelfConsWh = parseFloat(dp.p13116) || 0;    // daily direct self-consumption

      // 4) Transform to the old structure:
      const transformed = {
        energyDetails: {
          meters: [
            { type: "Production",      values: [{ value: dailyProductionWh }] },
            { type: "Consumption",     values: [{ value: dailyConsumptionWh }] },
            { type: "FeedIn",          values: [{ value: dailyFeedInWh }] },
            { type: "Purchased",       values: [{ value: dailyPurchasedWh }] },
            { type: "SelfConsumption", values: [{ value: dailySelfConsWh }] }
          ]
        }
      };

      // 5) Send to the front-end
      this.sendSocketNotification(
        "MMM-SunGrow-NOTIFICATION_SUNGROW_DAY_ENERGY_DATA_RECEIVED",
        transformed
      );

    } catch (error) {
      console.error("[MMM-SunGrow] fetchDayEnergyData error:", error);
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  }

});
