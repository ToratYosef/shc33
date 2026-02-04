// --- Email HTML Templates ---
const SHIPPING_LABEL_EMAIL_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your SecondHandCell Shipping Label is Ready!</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;background-color:#f4f4f4;margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}.email-container{max-width:600px;margin:20px auto;background-color:#ffffff;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.1);overflow:hidden;border:1px solid #e0e0e0}.header{background-color:#ffffff;padding:24px;text-align:center;border-bottom:1px solid #e0e0e0}.header h1{font-size:24px;color:#333333;margin:0;display:flex;align-items:center;justify-content:center;gap:10px}.header img{width:32px;height:32px}.content{padding:24px;color:#555555;font-size:16px;line-height:1.6}.content p{margin:0 0 16px}.content p strong{color:#333333}.order-id{color:#007bff;font-weight:bold}.tracking-number{color:#007bff;font-weight:bold}.button-container{text-align:center;margin:24px 0}.button{display:inline-block;background-color:#4CAF50;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:5px;font-weight:bold;font-size:16px;-webkit-transition:background-color .3s ease;transition:background-color .3s ease}.button:hover{background-color:#45a049}.footer{padding:24px;text-align:center;color:#999999;font-size:14px;border-top:1px solid #e0e0e0}</style></head><body><div class="email-container"><div class="header"><h1><img src="https://fonts.gstatic.com/s/e/notoemoji/16.0/1f4e6/72.png" alt="Box Icon">Your Shipping Label is Ready!</h1></div><div class="content"><p>Hello **CUSTOMER_NAME**,</p><p>You've chosen to receive a shipping label for order <strong class="order-id">#**ORDER_ID**</strong>. Here it is!</p><p>Your Tracking Number is: <strong class="tracking-number">**TRACKING_NUMBER**</strong></p><p>Please click the button below to download and print your label. Affix it to your package and drop it off at any USPS location.</p><div class="button-container"><a href="**LABEL_DOWNLOAD_LINK**" class="button">Download Your Shipping Label</a></div><p>We've also attached a custom label for your device. **Please print this label and place the sticker inside your package, on the bag that holds your device.** This helps us quickly identify your order when it arrives. It's very important to do this step correctly to avoid any delays.</p><p style="text-align:center;">We're excited to receive your device!</p></div><div class="footer"><p>Thank you for choosing SecondHandCell.</p></div></div></body></html>`;

const SHIPPING_KIT_EMAIL_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your SecondHandCell Shipping Kit is on its Way!</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;background-color:#f4f4f4;margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}.email-container{max-width:600px;margin:20px auto;background-color:#ffffff;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.1);overflow:hidden;border:1px solid #e0e0e0}.header{background-color:#ffffff;padding:24px;text-align:center;border-bottom:1px solid #e0e0e0}.header h1{font-size:24px;color:#333333;margin:0;display:flex;align-items:center;justify-content:center;gap:10px}.header img{width:32px;height:32px}.content{padding:24px;color:#555555;font-size:16px;line-height:1.6}.content p{margin:0 0 16px}.content p strong{color:#333333}.order-id{color:#007bff;font-weight:bold}.tracking-number{color:#007bff;font-weight:bold}.button-container{text-align:center;margin:24px 0}.button{display:inline-block;background-color:#4CAF50;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:5px;font-weight:bold;font-size:16px;-webkit-transition:background-color .3s ease;transition:background-color .3s ease}.button:hover{background-color:#45a049}.footer{padding:24px;text-align:center;color:#999999;font-size:14px;border-top:1px solid #e0e0e0}</style></head><body><div class="email-container"><div class="header"><h1><img src="https://fonts.gstatic.com/s/e/notoemoji/16.0/1f4e6/72.png" alt="Box Icon">Your Shipping Kit is on its Way!</h1></div><div class="content"><p>Hello **CUSTOMER_NAME**,</p><p>Thank you for your order <strong class="order-id">#**ORDER_ID**</strong>! Your shipping kit is on its way to you.</p><p>You can track its progress with the following tracking number: <strong class="tracking-number">**TRACKING_NUMBER**</strong></p><p>Once your kit arrives, simply place your device inside and use the included return label to send it back to us.</p><p>We're excited to receive your device!</p></div><div class="footer"><p>Thank you for choosing SecondHandCell.</p></div></div></body></html>`;

const ORDER_RECEIVED_EMAIL_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your SecondHandCell Order Has Been Received!</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;background-color:#f4f4f4;margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}.email-container{max-width:600px;margin:20px auto;background-color:#ffffff;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.1);overflow:hidden;border:1px solid #e0e0e0}.header{background-color:#ffffff;padding:24px;text-align:center;border-bottom:1px solid #e0e0e0}.header h1{font-size:24px;color:#333333;margin:0}.content{padding:24px;color:#555555;font-size:16px;line-height:1.6}.content p{margin:0 0 16px}.content p strong{color:#333333}.content h2{color:#333333;font-size:20px;margin-top:24px;margin-bottom:8px}.order-id{color:#007bff;font-weight:bold}ul{list-style-type:disc;padding-left:20px;margin:0 0 16px}ul li{margin-bottom:8px}.important-note{background-color:#fff3cd;border-left:4px solid #ffc107;padding:16px;margin-top:24px;font-size:14px;color:#856404}.footer{padding:24px;text-align:center;color:#999999;font-size:14px;border-top:1px solid #e0e0e0}</style></head><body><div class="email-container"><div class="header"><h1>Your SecondHandCell Order #**ORDER_ID** Has Been Received!</h1></div><div class="content"><p>Hello **CUSTOMER_NAME**,</p><p>Thank you for choosing SecondHandCell! We've successfully received your order request for your **DEVICE_NAME**.</p><p>Your Order ID is <strong class="order-id">#**ORDER_ID**</strong>.</p><h2>Next Steps: Preparing Your Device for Shipment</h2><p>Before you send us your device, it's crucial to prepare it correctly. Please follow these steps:</p><ul><li><strong>Backup Your Data:</strong> Ensure all important photos, contacts, and files are backed up to a cloud service or another device.</li><li><strong>Factory Reset:</strong> Perform a full factory reset on your device to erase all personal data. This is vital for your privacy and security.</li><li><strong>Remove Accounts:</strong> Sign out of all accounts (e.g., Apple ID/iCloud, Google Account, Samsung Account).<ul><li>For Apple devices, turn off "Find My iPhone" (FMI).</li><li>For Android devices, ensure Factory Reset Protection (FRP) is disabled.</li></ul></li><li><strong>Remove SIM Card:</strong> Take out any physical SIM cards from the device.</li><li><strong>Remove Accessories:</strong> Do not include cases, screen protectors, or chargers unless specifically instructed.</li></ul><div class="important-note"><p><strong>Important:</strong> We cannot process devices with <strong>Find My iPhone (FMI)</strong>, <strong>Factory Reset Protection (FRP)</strong>, <strong>stolen/lost status</strong>, <strong>outstanding balance due</strong>, or <strong>blacklisted IMEI</strong>. Please ensure your device meets these conditions to avoid delays or rejection.</p></div>**SHIPPING_INSTRUCTION**</div><div class="footer"><p>The SecondHandCell Team</p></div></div></body></html>`;

const BLACKLISTED_LEGAL_HTML = `
        <p style="margin: 0 0 16px;">State and local law require us to hold devices that test positive for a lost, stolen, or blacklisted status. Key regulations include:</p>
        <ul style="margin: 0 0 16px; padding-left: 20px;">
          <li><strong>New York Penal Law §§ 155.05(2)(b) &amp; 165.40–165.54:</strong> Buying or possessing property that is reported lost or stolen can constitute larceny or criminal possession of stolen property.</li>
          <li><strong>New York City Administrative Code §§ 20-272 &amp; 20-273:</strong> Secondhand dealers must record every transaction, report suspicious items to the NYPD, and hold flagged goods for law enforcement review.</li>
          <li><strong>New York General Business Law Article 6:</strong> Requires detailed recordkeeping and prohibits resale of devices until legal status issues are resolved.</li>
        </ul>
        <p style="margin: 0;">We will continue to cooperate with law enforcement and cannot release the device back to you unless they authorize it. For more information, review our <a href="https://secondhandcell.com/terms.html" style="color:#2563eb;">Terms &amp; Conditions</a> or reply with documentation clearing the device so we can re-run the check.</p>
      `;

const DEVICE_RECEIVED_EMAIL_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your Device Has Arrived!</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;background-color:#f4f4f4;margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}.email-container{max-width:600px;margin:20px auto;background-color:#ffffff;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.1);overflow:hidden;border:1px solid #e0e0e0}.header{background-color:#ffffff;padding:24px;text-align:center;border-bottom:1px solid #e0e0e0}.header h1{font-size:24px;color:#333333;margin:0}.content{padding:24px;color:#555555;font-size:16px;line-height:1.6}.content p{margin:0 0 16px}.content p strong{color:#333333}.footer{padding:24px;text-align:center;color:#999999;font-size:14px;border-top:1px solid #e0e0e0}.order-id{color:#007bff;font-weight:bold}</style></head><body><div class="email-container"><div class="header"><h1>Your Device Has Arrived!</h1></div><div class="content"><p>Hello **CUSTOMER_NAME**,</p><p>We've received your device for order <strong class="order-id">#**ORDER_ID**</strong>!</p><p>It's now in the queue for inspection. We'll be in touch soon with a final offer.</p></div><div class="footer"><p>Thank thank you for choosing SecondHandCell.</p></div></div></body></html>`;

const BLACKLISTED_EMAIL_HTML = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Important Notice Regarding Your Device - Order #**ORDER_ID**</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
      .email-container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; border: 1px solid #e0e0e0; }
      .header { background-color: #d9534f; color: #ffffff; padding: 24px; text-align: center; }
      .header h1 { font-size: 24px; margin: 0; }
      .content { padding: 24px; color: #555555; font-size: 16px; line-height: 1.6; }
      .content h2 { color: #d9534f; font-size: 20px; margin-top: 24px; margin-bottom: 8px; }
      .content p { margin: 0 0 16px; }
      .order-id { color: #d9534f; font-weight: bold; }
      .footer { padding: 24px; text-align: center; color: #999999; font-size: 14px; border-top: 1px solid #e0e0e0; }
    </style>
  </head>
  <body>
    <div class="email-container">
      <div class="header">
        <h1>Important Notice Regarding Your Device</h1>
      </div>
      <div class="content">
        <p>Hello **CUSTOMER_NAME**, </p>
        <p>This email is in reference to your device for order <strong class="order-id">#**ORDER_ID**</strong>.</p>
        <p>Upon verification, your device's IMEI has been flagged in the national database as **STATUS_REASON**.</p>
        <h2>Policy on Lost/Stolen Devices & Legal Compliance</h2>
        <p>SecondHandCell is committed to operating in full compliance with all applicable laws and regulations regarding the purchase and sale of secondhand goods, particularly those concerning lost or stolen property. This is a matter of legal and ethical compliance.</p>
        <p>Because the device is flagged, we cannot proceed with this transaction. Under New York law, we are required to report and hold any device suspected of being lost or stolen. The device cannot be returned to you. We must cooperate with law enforcement to ensure the device is handled in accordance with legal requirements.</p>
        <p>We advise you to contact your cellular carrier or the original owner of the device to resolve the status issue directly with them.</p>
        <p>For more details on the laws and our policy, please review the information below:</p>
        ${BLACKLISTED_LEGAL_HTML}
      </div>
      <div class="footer">
        <p>The SecondHandCell Team</p>
      </div>
    </div>
  </body>
  </html>
`;

const FMI_EMAIL_HTML = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Action Required for Order #**ORDER_ID**</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
      .email-container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; border: 1px solid #e0e0e0; }
      .header { background-color: #f0ad4e; color: #ffffff; padding: 24px; text-align: center; }
      .header h1 { font-size: 24px; margin: 0; }
      .content { padding: 24px; color: #555555; font-size: 16px; line-height: 1.6; }
      .content h2 { color: #f0ad4e; font-size: 20px; margin-top: 24px; margin-bottom: 8px; }
      .content p { margin: 0 0 16px; }
      .order-id { color: #f0ad4e; font-weight: bold; }
      .button-container { text-align: center; margin: 24px 0; }
      .button { display: inline-block; background-color: #f0ad4e; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px; }
      .footer { padding: 24px; text-align: center; color: #999999; font-size: 14px; border-top: 1px solid #e0e0e0; }
      .countdown-text { text-align: center; margin-top: 20px; font-size: 18px; font-weight: bold; color: #333333; }
    </style>
  </head>
  <body>
    <div class="email-container">
      <div class="header">
        <h1>Action Required for Your Order</h1>
      </div>
      <div class="content">
        <p>Hello **CUSTOMER_NAME**, </p>
        <p>This is a notification about your device for order <strong class="order-id">#**ORDER_ID**</strong>. We've detected that "Find My iPhone" (FMI) is still active on the device. **FMI must be turned off for us to complete your buyback transaction.**</p>
        <p>Please follow these steps to turn off FMI:</p>
        <ol>
          <li>Go to <a href="https://icloud.com/find" target="_blank">icloud.com/find</a> and sign in with your Apple ID.</li>
          <li>Click on "All Devices" at the top of the screen.</li>
          <li>Select the device you are sending to us.</li>
          <li>Click "Remove from Account".</li>
        </ol>
        <p>Once you have completed this step, please click the button below to let us know. You have **72 hours** to turn off FMI. If we don't receive confirmation within this period, your offer will be automatically reduced to the lowest possible price (as if the device were damaged).</p>
        <div class="button-container">
          <a href="**CONFIRM_URL**" class="button">Did it already? Click here.</a>
        </div>
        <div class="countdown-text">72-hour countdown has begun.</div>
        <p>If you have any questions, please reply to this email.</p>
      </div>
      <div class="footer">
        <p>The SecondHandCell Team</p>
      </div>
    </div>
  </body>
  </html>
`;

const BAL_DUE_EMAIL_HTML = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Action Required for Order #**ORDER_ID**</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
      .email-container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; border: 1px solid #e0e0e0; }
      .header { background-color: #f0ad4e; color: #ffffff; padding: 24px; text-align: center; }
      .header h1 { font-size: 24px; margin: 0; }
      .content { padding: 24px; color: #555555; font-size: 16px; line-height: 1.6; }
      .content h2 { color: #f0ad4e; font-size: 20px; margin-top: 24px; margin-bottom: 8px; }
      .content p { margin: 0 0 16px; }
      .order-id { color: #f0ad4e; font-weight: bold; }
      .footer { padding: 24px; text-align: center; color: #999999; font-size: 14px; border-top: 1px solid #e0e0e0; }
    </style>
  </head>
  <body>
    <div class="email-container">
      <div class="header">
        <h1>Action Required for Your Order</h1>
      </div>
      <div class="content">
        <p>Hello **CUSTOMER_NAME**, </p>
        <p>This is a notification about your device for order <strong class="order-id">#**ORDER_ID**</strong>. We've detected that a **FINANCIAL_STATUS** is on the device with your carrier.</p>
        <p>To continue with your buyback, you must resolve this with your carrier. Please contact them directly to clear the outstanding balance.</p>
        <p>You have **72 hours** to clear the balance. If we don't receive an updated status from our system within this period, your offer will be automatically reduced to the lowest possible price (as if the device were damaged).</p>
        <p>If you have any questions, please reply to this email.</p>
      </div>
      <div class="footer">
        <p>The SecondHandCell Team</p>
      </div>
    </div>
  </body>
  </html>
`;

const DOWNGRADE_EMAIL_HTML = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Update on Your Order - Order #**ORDER_ID**</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;background-color:#f4f4f4;margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}.email-container{max-width:600px;margin:20px auto;background-color:#ffffff;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.1);overflow:hidden;border:1px solid #e0e0e0}.header{background-color:#f0ad4e;color:#ffffff;padding:24px;text-align:center}.header h1{font-size:24px;margin:0}.content{padding:24px;color:#555555;font-size:16px;line-height:1.6}.content p{margin:0 0 16px}.order-id{color:#f0ad4e;font-weight:bold}.footer{padding:24px;text-align:center;color:#999999;font-size:14px;border-top:1px solid #e0e0e0}</style></head><body><div class="email-container"><div class="header"><h1>Update on Your Order</h1></div><div class="content"><p>Hello **CUSTOMER_NAME**,</p><p>This is an automated notification regarding your order <strong class="order-id">#**ORDER_ID**</strong>. The 72-hour period to resolve the issue with your device has expired. As a result, your offer has been automatically adjusted to the damaged device price, which is <strong>$**NEW_PRICE**</strong>.</p><p>If you have any questions, please reply to this email.</p></div><div class="footer"><p>The SecondHandCell Team</p></div></div></body></html>`;

module.exports = {
    SHIPPING_LABEL_EMAIL_HTML,
    SHIPPING_KIT_EMAIL_HTML,
    ORDER_RECEIVED_EMAIL_HTML,
    DEVICE_RECEIVED_EMAIL_HTML,
    BLACKLISTED_EMAIL_HTML,
    BLACKLISTED_LEGAL_HTML,
    FMI_EMAIL_HTML,
    BAL_DUE_EMAIL_HTML,
    DOWNGRADE_EMAIL_HTML
};
