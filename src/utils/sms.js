const axios = require('axios');

function isCustomerSmsEnabled() {
  return String(process.env.CUSTOMER_SMS_ENABLED || '').toLowerCase() === 'true'
    && Boolean(process.env.SMS_API_KEY);
}

async function sendSMS(phoneNumber, message) {
  if (!isCustomerSmsEnabled()) {
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
    console.error('Customer SMS delivery failed');
    // Don't throw - a failed SMS shouldn't break the shipment flow
    return { error: true };
  }
}

module.exports = { isCustomerSmsEnabled, sendSMS };
