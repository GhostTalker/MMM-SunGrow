/* node_helper.js
 * MagicMirror Module: MMM-SunGrow
 *
 * 1) Wait for front-end "DETAILS_DATA" request
 * 2) Use /openapi/getPowerStationDetail with the new payload
 * 3) Transform result_data into the old structure
 */

const NodeHelper = require("node_helper");
const fetch = require("node-fetch");

module.exports = NodeHelper.create({
  start: function () {
    console.log("[MMM-SunGrow] node_helper started...");
    this.config = null;
    this.token = null; // We'll store the iSolarCloud token here
  },

  /**
   * Handle incoming notifications.
   */
  socketNotificationReceived: async function (notification, payload) {
    // 1) Initial config
    if (notification === "SUN_GROW_CONFIG") {
      this.config = payload;
      console.log("[MMM-SunGrow] Received config:", this.config);

      // If we have no token yet, login:
      if (!this.token) {
        await this.loginToISolarCloud();
      }
      return;
    }

    // 2) Listen for detail requests from front-end
    switch (notification) {
      case "MMM-SunGrow-NOTIFICATION_SUNGROW_DETAILS_DATA_REQUESTED":
        if (!this.token) {
          await this.loginToISolarCloud();
        }
        this.fetchDetailsData();
        break;

      // You could add other requests (current power, overview, etc.)
    }
  },

  /**
   * LOGIN step:
   *   POST /openapi/login with user, password, etc.
   */
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
        sys_code: "207", // per your note, might differ from previous "901"
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

      // Save the token
      this.token = loginData.result_data.token;
      console.log("[MMM-SunGrow] /openapi/login success, token:", this.token);

    } catch (error) {
      console.error("[MMM-SunGrow] Error in loginToISolarCloud:", error);
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  },

  /**
   * fetchDetailsData():
   *   Calls /openapi/getPowerStationDetail with the new fields:
   *   - sn (serial number)
   *   - sys_code: 207
   *   - is_get_ps_remarks: "1"
   *   Then transforms result_data => old structure
   */
  fetchDetailsData: async function () {
    if (!this.token) {
      console.warn("[MMM-SunGrow] No token, cannot fetch details data!");
      this.sendSocketNotification("SUN_GROW_ERROR", {
        message: "No token available."
      });
      return;
    }

    // We assume 'this.config.sn' contains "B22C2803603"
    if (!this.config.plantSN) {
      console.warn("[MMM-SunGrow] No plantSN in config!");
      this.sendSocketNotification("SUN_GROW_ERROR", {
        message: "No sn in config."
      });
      return;
    }

    try {
      const url = `${this.config.portalUrl}/openapi/getPowerStationDetail`;
      const body = {
        appkey: this.config.appKey || "",
        is_get_ps_remarks: "1",
        lang: "_en_US",
        sn: this.config.plantSN,       // <-- this is required
        sys_code: "207",          // as per your note
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

      const rd = json.result_data;

      // We'll convert 'design_capacity' (e.g. 14050) to 14.05 kW => old "peakPower".
      // Old code: dataNotificationDetails.details.location.address
      //           dataNotificationDetails.details.location.city
      //           dataNotificationDetails.details.peakPower
      const transformed = {
        details: {
          location: {
            address: rd.ps_location || "No address"
          },
          // design_capacity in watts => /1000 => kW
          // If design_capacity=14050 => 14.05 kW
          peakPower: (rd.design_capacity || 0) / 1000
        }
      };

      // Send it to front-end as "MMM-SunGrow-NOTIFICATION_SUNGROW_DETAILS_DATA_RECEIVED"
      this.sendSocketNotification(
        "MMM-SunGrow-NOTIFICATION_SUNGROW_DETAILS_DATA_RECEIVED",
        transformed
      );

    } catch (error) {
      console.error("[MMM-SunGrow] fetchDetailsData error:", error);
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  }
}),
async fetchStorageData() {
  if (!this.token) {
    console.warn("[MMM-SunGrow] No token. Re-login or abort.");
    this.sendSocketNotification("SUN_GROW_ERROR", { message: "No token for battery data." });
    return;
  }

  try {
    const url = `${this.config.portalUrl}/openapi/getBatteryMeasuringPoints`;

    const body = {
      appkey: this.config.appKey || "",
      device_type: "43",
      lang: "_en_US",
      point_id_list: ["58604", "58608", "58601", "58602"],
      ps_key_list: [ "5326778_43_2_1" ],  // or from your config
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
        await this.loginToISolarCloud();
        return;
      }
      throw new Error(`Battery data HTTP error! status: ${res.status}`);
    }

    const json = await res.json();
    if (json.result_code !== "1") {
      throw new Error(`Battery data error: ${json.result_msg}`);
    }

    // device_point includes p58604=SoC fraction, p58608=status code, p58601=voltage, p58602=amperage
    const dp = json.result_data.device_point_list?.[0]?.device_point;
    if (!dp) {
      console.warn("[MMM-SunGrow] No device_point in battery response");
      return;
    }

    // Convert strings to floats
    const socFraction = parseFloat(dp.p58604) || 0;  // e.g. "0.448" => 0.448
    const voltage = parseFloat(dp.p58601) || 0;      // e.g. 260.9
    const current = parseFloat(dp.p58602) || 0;      // e.g. 1.9
    const statusCode = dp.p58608 || "0";             // e.g. "2"

    // Map numeric codes to text
    let statusText;
    // We'll also define connections as an array of {from, to} objects
    const connections = [];
    switch (statusCode) {
      case "1":
        statusText = "Charging";
        // If the battery is charging, let's say "LOAD" -> "STORAGE"
        // so the front-end gets "load_storage"
        connections.push({ from: "LOAD", to: "STORAGE" });
        break;
      case "2":
        statusText = "Discharging";
        // If the battery is discharging, "STORAGE" -> "LOAD"
        // => "storage_load"
        connections.push({ from: "STORAGE", to: "LOAD" });
        break;
      case "0":
        statusText = "Idle";
        // No arrow for idle
        break;
      default:
        statusText = `Unknown(${statusCode})`;
        // Also no arrow
    }

    // Approximate power in watts
    const powerW = voltage * current;

    // Build old structure
    const transformed = {
      siteCurrentPowerFlow: {
        STORAGE: {
          currentPower: powerW,             // e.g. 495.71
          status: statusText,               // "Charging", "Discharging", "Idle", ...
          chargeLevel: socFraction * 100    // e.g. 44.8
        },
        // Provide placeholders for other sub-objects if you want
        PV:   { currentPower: 0, status: "Unknown" },
        LOAD: { currentPower: 0, status: "Unknown" },
        GRID: { currentPower: 0, status: "Unknown" },
        // Insert our arrow logic here
        connections: connections,
        unit: "W"
      }
    };

    // Send to the front-end
    this.sendSocketNotification(
      "MMM-SunGrow-NOTIFICATION_SUNGROW_CURRENTPOWER_DATA_RECEIVED",
      transformed
    );

  } catch (error) {
    console.error("[MMM-SunGrow] fetchStorageData error:", error);
    this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
  }
}

;
