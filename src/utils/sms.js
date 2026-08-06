const axios = require('axios');

/**
 * Stub SMS sender. Swap this for whatever PH SMS provider you use
 * (Semaphore, Movider, iTexMo, etc). Example below uses Semaphore's
 * API shape as a placeholder — check your provider's actual docs.
 */
async function sendSMS(phoneNumber, message) {
  if (!process.env.SMS_API_KEY) {
    console.log(`[SMS SKIPPED - no API key set] Would send to ${phoneNumber}: ${message}`);
    return { skipped: true };
  }

  try {
    const response = await axios.post('https://api.semaphore.co/api/v4/messages', {
      apikey: process.env.SMS_API_KEY,
      number: phoneNumber,
      message: message,
      sendername: process.env.SMS_SENDER_NAME || 'BEAUPlus'
    });
    return response.data;
  } catch (err) {
    console.error('SMS send failed:', err.response?.data || err.message);
    // Don't throw - a failed SMS shouldn't break the shipment flow
    return { error: true };
  }
}

module.exports = { sendSMS };
