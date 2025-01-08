/* node_helper.js
 * MagicMirror Module: MMM-SunGrow
 *
 * This version logs into iSolarCloud via /v1/common/login using user & password,
 * then stores the token for subsequent requests to /v1/plant/getPlantDetail, etc.
 */

const NodeHelper = require("node_helper");
const fetch = require("node-fetch");

module.exports = NodeHelper.create({

  start: function () {
    console.log("[MMM-SunGrow] node_helper started...");
    this.config = null;
    this.token = null;          // We'll store the iSolarCloud token here
    this.updateTimer = null;    // Timer for refresh loop
  },

  // Receive config from front-end (MMM-SunGrow.js)
  socketNotificationReceived: function (notification, payload) {
    if (notification === "SUN_GROW_CONFIG") {
      this.config = payload;
      console.log("[MMM-SunGrow] Received config:", this.config);

      // Clear any previous timer if re-initialized
      if (this.updateTimer) {
        clearTimeout(this.updateTimer);
        this.updateTimer = null;
      }

      // Start the login->data retrieval process
      this.loginToISolarCloud();
    }
  },

  /**
   * 1) LOGIN step:
   *    POST /v1/common/login
   *    Body includes { "user": "xxx", "password": "yyy" }
   */
  loginToISolarCloud: async function () {
    try {
      // Check if user + password are in config
      if (!this.config.userName || !this.config.userPassword) {
        throw new Error("No user/password provided in config for iSolarCloud login.");
      }

      const loginUrl = `${this.config.portalUrl}/openapi/login`;
      const body = {
        appkey: this.config.appKey || "",
        user_account: this.config.userName || "",
        user_password: this.config.userPassword || "",
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
      // Check if loginData.result_code === "1" (success)
      if (loginData.result_code !== "1") {
        throw new Error(`Login error: ${loginData.result_msg || "Unknown error"}`);
      }

      // Extract the token from the response
      // Typically: loginData.result_data.token
      this.token = loginData.result_data.token;
      console.log("[MMM-SunGrow] /openapi/login response:", loginData);

      // Now that we have a token, let's fetch the plant data
      this.getSolarData();
    } catch (error) {
      console.error("[MMM-SunGrow] Error in loginToISolarCloud:", error);
      // Inform the front-end
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
      // Retry login after some time?
      this.scheduleNextUpdate();
    }
  },

  /**
   * 2) DATA step:
   *    Example: /v1/plant/getPlantDetail
   *    Must include the token from login, typically in the request header or body
   */
  getSolarData: async function () {
    if (!this.token) {
      console.error("[MMM-SunGrow] No token available, cannot fetch plant data.");
      this.scheduleNextUpdate();
      return;
    }
    if (!this.config.plantId) {
      console.error("[MMM-SunGrow] No plantId set in config, cannot fetch plant data.");
      this.scheduleNextUpdate();
      return;
    }

    try {
      const url = "https://developer-api.isolarcloud.com/v1/plant/getPlantDetail";
      const body = {
        plantId: this.config.plantId
      };

      // Often iSolarCloud requires the token either as a request header or
      // as part of the body. The docs say "token: xxxxxx" in the header:
      // (Check "Common Request Headers" or "Example Request" in the docs.)
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "token": this.token            // if needed in the header
          // or "Authorization": `Bearer ${this.token}`, etc., depending on docs
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        // Possibly the token expired? We might need to re-login.
        if (res.status === 401) {
          console.warn("[MMM-SunGrow] Token might have expired; re-login needed.");
          this.token = null; // Clear token
          this.loginToISolarCloud();
          return;
        }
        throw new Error(`getPlantDetail HTTP error! status: ${res.status}`);
      }

      const result = await res.json();

      // Check success code
      if (result.result_code !== "1") {
        throw new Error(`getPlantDetail error: ${result.result_msg}`);
      }

      // Now result.result_data likely has the plant details
      // Example fields: dailyPower, totalPower, etc.
      // You can log or parse them:
      // console.log("[MMM-SunGrow] Plant data:", result.result_data);

      // Send data to the front-end for rendering
      this.sendSocketNotification("SUN_GROW_DATA", result);

    } catch (error) {
      console.error("[MMM-SunGrow] Error in getSolarData:", error);
      // Send error to front-end
      this.sendSocketNotification("SUN_GROW_ERROR", { message: error.message });
    } finally {
      // Schedule next update
      this.scheduleNextUpdate();
    }
  },

  // Helper to schedule the next data refresh
  scheduleNextUpdate: function () {
    const refreshInterval = this.config.updateInterval || (10 * 60 * 1000);
    this.updateTimer = setTimeout(() => {
      // We already have a token or not. If we have one, call getSolarData().
      // If it might have expired, login again. This logic is up to you.
      if (this.token) {
        this.getSolarData();
      } else {
        this.loginToISolarCloud();
      }
    }, refreshInterval);
  }

});
