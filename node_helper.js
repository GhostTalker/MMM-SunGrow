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

      // The new result_data is an object with fields like:
      // {
      //   "design_capacity": 14050,
      //   "ps_location": "Adolphsbühlstraße 71...",
      //   "ps_name": "Schulze_Adelsberg",
      //   "install_date": "...",
      //   ...
      // }
      const rd = json.result_data;

      // We'll convert 'design_capacity' (e.g. 14050) to 14.05 kW => old "peakPower".
      // Old code: dataNotificationDetails.details.location.address
      //           dataNotificationDetails.details.location.city
      //           dataNotificationDetails.details.peakPower
      // There's no separate city, so we set city: "Unknown".
      const transformed = {
        details: {
          location: {
            address: rd.ps_location || "No address",
            city: "Unknown"
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
});
