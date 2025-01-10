/* node_helper.js
 * MagicMirror Module: MMM-SunGrow
 *
 * Updated to:
 * 1) Wait for front-end requests ("MMM-SunGrow-NOTIFICATION_SUNGROW_DETAILS_DATA_REQUESTED")
 * 2) Reshape the new JSON to match the old "details" structure
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
   * Handle incoming notifications from MMM-SunGrow.js
   */
  socketNotificationReceived: async function (notification, payload) {
    // 1) Initial config
    if (notification === "SUN_GROW_CONFIG") {
      this.config = payload;
      console.log("[MMM-SunGrow] Received config:", this.config);

      // If we have no token yet, login. Otherwise, do nothing (we'll wait for data requests).
      if (!this.token) {
        await this.loginToISolarCloud();
      }
      return;
    }

    // 2) Listen for the front-end's data requests
    switch (notification) {
      case "MMM-SunGrow-NOTIFICATION_SUNGROW_DETAILS_DATA_REQUESTED":
        // If we don't have a token or it might have expired, try re-login
        if (!this.token) {
          await this.loginToISolarCloud();
        }
        this.fetchDetailsData();
        break;

      // (You could add other requests here, e.g. CURRENTPOWER, OVERVIEW, DAY_ENERGY, etc.)
    }
  },

  /**
   * LOGIN step:
   *   POST /openapi/login with user & password + x-access-key
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
        sys_code: "901",
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

      // Store token
      this.token = loginData.result_data.token;
      console.log("[MMM-SunGrow] /openapi/login success, token:", this.token);

    } catch (error) {
      console.error("[MMM-SunGrow] Error in loginToISolarCloud:", error);
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    }
  },

  /**
   * fetchDetailsData():
   *   Called when the front-end requests "details" data.
   *   Endpoint: /openapi/getPowerStationDetail
   *   We transform the JSON to match "dataNotificationDetails.details" structure.
   */
  fetchDetailsData: async function () {
    if (!this.token) {
      console.warn("[MMM-SunGrow] No token, cannot fetch details data!");
      this.sendSocketNotification("SUN_GROW_ERROR", {
        message: "No token available."
      });
      return;
    }
    if (!this.config.plantId) {
      console.warn("[MMM-SunGrow] No plantId in config!");
      this.sendSocketNotification("SUN_GROW_ERROR", {
        message: "No plantId in config."
      });
      return;
    }

    try {
      const url = `${this.config.portalUrl}/openapi/getPowerStationDetail`;
      const body = {
        appkey: this.config.appKey || "",
        is_get_ps_remarks: "1",
        lang: "_en_US",
        sys_code: "901",
        token: this.token,
        ps_id: this.config.plantId
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

      // We have something like:
      // json.result_data.data_list = [ { ps_id: 473465, ps_name: "...", install_power: 27250, ... }, {...}, ... ]
      // Find the station matching this.config.plantId
      const dataList = json.result_data.data_list || [];
      const matchingItem = dataList.find(
        (item) => item.ps_id === parseInt(this.config.plantId)
      );

      if (!matchingItem) {
        console.warn("[MMM-SunGrow] No matching ps_id in data_list for plantId:", this.config.plantId);
        // Send an empty fallback
        this.sendSocketNotification("MMM-SunGrow-NOTIFICATION_SUNGROW_DETAILS_DATA_RECEIVED", {
          details: {
            location: { address: "", city: "" },
            peakPower: 0
          }
        });
        return;
      }

      // Transform to old structure:
      // old code expects: dataNotificationDetails.details.location.address
      //                  dataNotificationDetails.details.location.city
      //                  dataNotificationDetails.details.peakPower
      const transformed = {
        details: {
          location: {
            address: matchingItem.ps_location || "No address",
            // The old code used city; we only have a combined address. We'll set city to "Unknown":
            city: "Unknown"
          },
          // If install_power = 27250 means 27.25 kW, do /1000:
          peakPower: (matchingItem.install_power || 0) / 1000
        }
      };

      // Send to front-end under the correct notification name:
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
