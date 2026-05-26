const FROM_ADDRESS = 'sales@secondhandcell.com';

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainTextToHtml(value = '') {
  const normalized = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 14px;">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function renderAdminEmailTemplate({
  emailTitle,
  customerName,
  rawAdminMessage,
  orderId,
  trackOrderUrl,
}) {
  const safeCustomerName = String(customerName || '').trim();
  const greetingHtml = safeCustomerName
    ? `Hi <strong>${escapeHtml(safeCustomerName)}</strong>,`
    : 'Hi,';
  const adminMessageHtml = plainTextToHtml(rawAdminMessage);
  const showOrderBox = Boolean(orderId);
  const showTrackButton = Boolean(orderId && trackOrderUrl);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(emailTitle || 'SecondHandCell Update')}</title></head><body style="margin:0; padding:0; background-color:#f3f4f6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#111111;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f3f4f6; margin:0; padding:32px 16px;"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px; background:#ffffff; border-radius:28px; overflow:hidden; border:1px solid #e5e7eb; box-shadow:0 12px 40px rgba(0,0,0,0.04);"><tr><td style="padding:20px 24px 16px 24px; background:#ffffff; border-bottom:1px solid #f1f1f1;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="84" valign="middle" style="width:84px;"><a href="https://secondhandcell.com" style="text-decoration:none; display:inline-block;"><img src="https://cdn.secondhandcell.com/images/assets/logo-white.webp" alt="SecondHandCell" style="height:44px; display:block; margin:0;" /></a></td><td align="center" valign="middle" style="padding:0 10px;"><a href="https://secondhandcell.com" style="text-decoration:none; display:inline-block;"><div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',Arial,sans-serif; font-size:28px; line-height:32px; font-weight:600; letter-spacing:-0.5px; color:#111827; text-align:center;"><span style="color:#111827;">Second</span><span style="color:#16A34A;">HandCell</span></div><div style="margin-top:6px; font-family:-apple-system,BlinkMacSystemFont,'Inter',Arial,sans-serif; font-size:11px; line-height:16px; font-weight:400; color:#16A34A; text-align:center;">Turn Your Old <span style="color:#0F172A;">Phone Into Cash!</span></div></a></td><td width="84" style="width:84px;">&nbsp;</td></tr></table></td></tr><tr><td style="padding:42px 36px 18px 36px; text-align:center;"><div style="width:64px; height:4px; border-radius:999px; background:#16a34a; margin:0 auto 18px auto;"></div><div style="font-size:34px; line-height:38px; font-weight:600; letter-spacing:-0.04em; color:#111111; margin-bottom:0;">${escapeHtml(emailTitle || 'SecondHandCell Update')}</div></td></tr><tr><td style="padding:0 36px 0 36px; font-size:16px; line-height:26px; color:#3f3f46;"><p style="font-size:17px; margin:0 0 14px;">${greetingHtml}</p><div style="margin:0 0 24px; color:#475569; font-size:16px; line-height:26px;">${adminMessageHtml}</div>${showOrderBox ? `<div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:18px 20px; margin:20px 0 24px;"><div style="font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:#64748b; margin-bottom:10px; font-weight:600;">Order Information</div><p style="margin:0 0 8px; color:#0f172a;"><strong>Order ID:</strong> #${escapeHtml(orderId)}</p><p style="margin:0; color:#475569;">You can reply directly to this email if you have any questions.</p></div>` : ''}${showTrackButton ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:24px auto 24px;"><tr><td style="border-radius:999px; background:#ffffff; border:1px solid #d1d5db; text-align:center;"><a href="${escapeHtml(trackOrderUrl)}" style="display:inline-block; padding:14px 23px; font-size:14px; line-height:14px; font-weight:600; letter-spacing:-0.01em; color:#111111; text-decoration:none; border-radius:999px;">Track Your Order</a></td></tr></table>` : ''}<div style="border-top:1px solid #e2e8f0; padding-top:20px; margin-top:26px;"><div style="font-size:18px; font-weight:700; color:#0f172a; margin:0 0 10px;">Need help?</div><p style="margin:0; color:#475569;">Reply to this email or contact us at <a href="mailto:sales@secondhandcell.com" style="color:#2563eb; text-decoration:none;">sales@secondhandcell.com</a>.</p></div></td></tr><tr><td style="padding:34px 36px 34px 36px;"><div style="border-top:1px solid #eeeeee; padding-top:22px; text-align:center; font-size:12px; line-height:20px; color:#9ca3af;"><div style="font-weight:600; color:#6b7280; margin-bottom:4px;">SecondHandCell.com</div><div><a href="https://secondhandcell.com" style="color:#8b8b8f; text-decoration:none;">SecondHandCell.com</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="mailto:sales@secondhandcell.com" style="color:#8b8b8f; text-decoration:none;">sales@secondhandcell.com</a></div><div style="margin-top:6px;">© 2026 SecondHandCell. All rights reserved.</div></div></td></tr></table></td></tr></table></body></html>`;
}

module.exports = { FROM_ADDRESS, plainTextToHtml, renderAdminEmailTemplate };
