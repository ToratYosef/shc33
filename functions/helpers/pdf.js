const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const bwipjs = require('bwip-js');

const PACKING_SLIP_WIDTH = 288; // 4 inches (72 pts per inch)
const PACKING_SLIP_HEIGHT = 432; // 6 inches
const PACKING_SLIP_MARGIN = 20;
const BAG_LABEL_WIDTH = 288; // 4 inches wide
const BAG_LABEL_HEIGHT = 144; // 2 inches tall
const BAG_LABEL_MARGIN_X = 16;
const BAG_LABEL_MARGIN_Y = 12;
const LINE_HEIGHT = 14;

/**
 * Helper function to generate a branded 4x6 packing slip label.
 * @param {Object} order - Firestore order payload.
 * @returns {Promise<Buffer>} PDF buffer ready for download/print.
 */
async function generateCustomLabelPdf(order) {
    const pdfDoc = await PDFDocument.create();
    const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let page = pdfDoc.addPage([PACKING_SLIP_WIDTH, PACKING_SLIP_HEIGHT]);
    let { width, height } = page.getSize();
    let cursorY = height - PACKING_SLIP_MARGIN;

    const ensureSpace = (lineCount = 1) => {
        const required = lineCount * LINE_HEIGHT + 36;
        if (cursorY - required < PACKING_SLIP_MARGIN) {
            page = pdfDoc.addPage([PACKING_SLIP_WIDTH, PACKING_SLIP_HEIGHT]);
            ({ width, height } = page.getSize());
            cursorY = height - PACKING_SLIP_MARGIN;
        }
    };

    const drawSectionTitle = (title) => {
        ensureSpace(2);
        page.drawText(title, {
            x: PACKING_SLIP_MARGIN,
            y: cursorY,
            size: 13,
            font: boldFont,
            color: rgb(0.16, 0.18, 0.22),
        });
        cursorY -= LINE_HEIGHT;
        cursorY -= 2;
    };

    const drawKeyValue = (label, value) => {
        const labelText = `${label}:`;
        const labelSize = 10;
        const valueSize = 10;
        const safeValue = value && String(value).trim().length ? String(value).trim() : '—';
        const labelWidth = boldFont.widthOfTextAtSize(labelText, labelSize);
        const availableWidth = width - PACKING_SLIP_MARGIN * 2 - labelWidth - 8;
        const lines = wrapText(safeValue, availableWidth, regularFont, valueSize);
        ensureSpace(lines.length);

        page.drawText(labelText, {
            x: PACKING_SLIP_MARGIN,
            y: cursorY,
            size: labelSize,
            font: boldFont,
            color: rgb(0.12, 0.12, 0.14),
        });

        lines.forEach((line, index) => {
            page.drawText(line, {
                x: PACKING_SLIP_MARGIN + labelWidth + 8,
                y: cursorY - index * LINE_HEIGHT,
                size: valueSize,
                font: regularFont,
                color: rgb(0.1, 0.1, 0.1),
            });
        });

        cursorY -= LINE_HEIGHT * lines.length;
        cursorY -= 4;
    };

    const formatPhoneNumber = (raw) => {
        if (!raw) return '—';
        const digits = String(raw).replace(/\D+/g, '');
        if (digits.length === 11 && digits.startsWith('1')) {
            return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
        }
        if (digits.length === 10) {
            return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
        }
        return String(raw);
    };

    const shippingInfo = order.shippingInfo || {};
    const contactPhone =
        shippingInfo.phone ||
        shippingInfo.phoneNumber ||
        shippingInfo.phone_number ||
        shippingInfo.contactPhone ||
        '';

    const deviceParts = [];
    if (order.brand) deviceParts.push(String(order.brand));
    if (order.device) deviceParts.push(String(order.device));
    const itemLabel = deviceParts.join(' ').trim();

    const estimatedPayout = resolveOrderPayout(order);

    page.drawText('SecondHandCell', {
        x: PACKING_SLIP_MARGIN,
        y: cursorY,
        size: 16,
        font: boldFont,
        color: rgb(0.07, 0.2, 0.47),
    });
    cursorY -= LINE_HEIGHT;

    page.drawText(`Order #${order.id || '—'}`, {
        x: PACKING_SLIP_MARGIN,
        y: cursorY,
        size: 12,
        font: boldFont,
        color: rgb(0.12, 0.12, 0.14),
    });
    cursorY -= LINE_HEIGHT;
    cursorY -= 6;

    drawSectionTitle('Customer Information');
    drawKeyValue('Customer Name', shippingInfo.fullName || shippingInfo.name || '—');
    drawKeyValue('Email', shippingInfo.email || '—');
    drawKeyValue('Phone', formatPhoneNumber(contactPhone));

    drawSectionTitle('Device Details');
    drawKeyValue('Item (Make/Model)', itemLabel || '—');
    drawKeyValue('Storage', order.storage || order.memory || '—');
    drawKeyValue('Carrier', formatValue(order.carrier));
    drawKeyValue('Estimated Payout', `$${formatCurrency(estimatedPayout)}`);

    drawSectionTitle('Conditions');
    drawKeyValue('Powers On?', formatValue(order.condition_power_on));
    drawKeyValue('Fully Functional?', formatValue(order.condition_functional));
    drawKeyValue('Any Cracks?', formatValue(order.condition_cracks));
    drawKeyValue('Cosmetic Condition', formatValue(order.condition_cosmetic));

    ensureSpace(4);
    const barcodeSvg = await buildBarcode(order.id || String(order.orderId || ''));
    const barcodeImage = await pdfDoc.embedSvg(barcodeSvg);
    const maxBarcodeWidth = width - PACKING_SLIP_MARGIN * 2;
    const barcodeScale = Math.min(maxBarcodeWidth / barcodeImage.width, 1.1);
    const dims = barcodeImage.scale(barcodeScale);
    const barcodeY = Math.max(PACKING_SLIP_MARGIN + 18, cursorY - dims.height - 10);

    page.drawImage(barcodeImage, {
        x: (width - dims.width) / 2,
        y: barcodeY,
        width: dims.width,
        height: dims.height,
    });

    const caption = 'Scan to view order details';
    const captionSize = 8;
    const captionWidth = boldFont.widthOfTextAtSize(caption, captionSize);
    page.drawText(caption, {
        x: (width - captionWidth) / 2,
        y: barcodeY - 12,
        size: captionSize,
        font: boldFont,
        color: rgb(0.28, 0.28, 0.32),
    });

    return pdfDoc.save();
}

async function generateBagLabelPdf(order) {
    const pdfDoc = await PDFDocument.create();
    const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const page = pdfDoc.addPage([BAG_LABEL_WIDTH, BAG_LABEL_HEIGHT]);
    const { width, height } = page.getSize();
    const barcodeReserve = BAG_LABEL_MARGIN_Y + 48;
    let cursorY = height - BAG_LABEL_MARGIN_Y;

    const drawLine = (text, options = {}) => {
        const { font = regularFont, size = 10, color = rgb(0, 0, 0), gap = 6 } = options;
        const lineHeight = size + 4;

        if (!text) {
            cursorY = Math.max(cursorY - gap, barcodeReserve);
            return;
        }

        const lines = wrapText(text, width - BAG_LABEL_MARGIN_X * 2, font, size);
        lines.forEach((line) => {
            cursorY = Math.max(cursorY - lineHeight, barcodeReserve);
            page.drawText(line, {
                x: BAG_LABEL_MARGIN_X,
                y: cursorY,
                size,
                font,
                color,
            });
        });

        cursorY = Math.max(cursorY - gap, barcodeReserve);
    };

    const shippingInfo = order.shippingInfo || {};
    const contactName = shippingInfo.fullName || shippingInfo.name || 'Customer';
    const contactPhone =
        shippingInfo.phone ||
        shippingInfo.phoneNumber ||
        shippingInfo.phone_number ||
        '';

    const deviceParts = [];
    if (order.brand) deviceParts.push(String(order.brand));
    if (order.device) deviceParts.push(String(order.device));
    const deviceLabel = deviceParts.join(' ');
    const storageLabel = order.storage || order.memory || '';
    const lockLabel = formatValue(order.carrier);
    const conditionSummary = order.condition || order.deviceCondition || buildConditionSummary(order);
    const qualityLabel = conditionSummary && conditionSummary !== '—'
        ? conditionSummary
        : formatValue(order.condition_grade || order.quality);
    const payoutAmount = resolveOrderPayout(order);

    drawLine('SecondHandCell', {
        font: boldFont,
        size: 9,
        color: rgb(0.32, 0.32, 0.36),
        gap: 2,
    });
    drawLine(`Order #${order.id}`, {
        font: boldFont,
        size: 18,
        color: rgb(0.12, 0.16, 0.48),
        gap: 6,
    });

    const deviceLineParts = [];
    if (deviceLabel) deviceLineParts.push(deviceLabel);
    if (storageLabel) deviceLineParts.push(storageLabel);
    drawLine(deviceLineParts.join(' • '), {
        font: boldFont,
        size: 11,
        color: rgb(0.08, 0.08, 0.1),
        gap: 2,
    });

    const specParts = [];
    if (lockLabel && lockLabel !== '—') specParts.push(`Lock: ${lockLabel}`);
    if (qualityLabel && qualityLabel !== '—') specParts.push(`Quality: ${qualityLabel}`);
    drawLine(specParts.join('    '), {
        size: 9,
        color: rgb(0.28, 0.28, 0.32),
        gap: 3,
    });

    const contactParts = [contactName];
    if (contactPhone) contactParts.push(contactPhone);
    const cityLine = [shippingInfo.city, shippingInfo.state]
        .filter(Boolean)
        .join(', ');
    if (cityLine) contactParts.push(cityLine);
    drawLine(contactParts.join(' • '), {
        size: 9,
        color: rgb(0.24, 0.24, 0.28),
        gap: 3,
    });

    drawLine(`Quote: $${formatCurrency(payoutAmount)}`, {
        font: boldFont,
        size: 14,
        color: rgb(0.1, 0.5, 0.26),
        gap: 8,
    });

    drawLine('Attach this label to the device bag.', {
        size: 8,
        color: rgb(0.45, 0.45, 0.45),
        gap: 6,
    });

    const barcodeSvg = await buildBarcode(order.id);
    const barcodeImage = await pdfDoc.embedSvg(barcodeSvg);
    const maxBarcodeWidth = width - BAG_LABEL_MARGIN_X * 2;
    const maxBarcodeHeight = 36;
    const barcodeScale = Math.min(
        maxBarcodeWidth / barcodeImage.width,
        maxBarcodeHeight / barcodeImage.height,
        1.2
    );
    const dims = barcodeImage.scale(barcodeScale);
    const barcodeY = BAG_LABEL_MARGIN_Y + 14;

    page.drawImage(barcodeImage, {
        x: (width - dims.width) / 2,
        y: barcodeY,
        width: dims.width,
        height: dims.height,
    });

    const caption = 'Scan to open this order';
    const captionSize = 8;
    const captionWidth = boldFont.widthOfTextAtSize(caption, captionSize);
    page.drawText(caption, {
        x: (width - captionWidth) / 2,
        y: barcodeY - 10,
        size: captionSize,
        font: boldFont,
        color: rgb(0.35, 0.35, 0.35),
    });

    return pdfDoc.save();
}

function resolveOrderPayout(order = {}) {
    const candidates = [
        order.finalPayoutAmount,
        order.finalPayout,
        order.finalOfferAmount,
        order.finalOffer,
        order.payoutAmount,
        order.payout,
        order.reOffer && order.reOffer.newPrice,
        order.estimatedQuote,
    ];

    for (const value of candidates) {
        if (value === undefined || value === null) {
            continue;
        }
        const numeric = Number(value);
        if (!Number.isNaN(numeric)) {
            return numeric;
        }
    }

    return 0;
}

function formatCurrency(value) {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
        return '0.00';
    }
    return numeric.toFixed(2);
}

function buildConditionSummary(order = {}) {
    const segments = [
        order.condition_power_on ? `Powers On: ${formatValue(order.condition_power_on)}` : null,
        order.condition_functional ? `Functional: ${formatValue(order.condition_functional)}` : null,
        order.condition_cosmetic ? `Cosmetic: ${formatValue(order.condition_cosmetic)}` : null,
    ].filter(Boolean);

    return segments.join(' • ');
}

function formatValue(value) {
    if (!value) return '—';
    return String(value)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatLabel(label = '') {
    return label
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function buildBarcode(data) {
    return new Promise((resolve, reject) => {
        bwipjs.toSVG(
            {
                bcid: 'code128',
                text: data,
                scale: 2.8,
                height: 12,
                includetext: false,
                textxalign: 'center',
            },
            (err, svg) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(svg);
                }
            }
        );
    });
}

function wrapText(text, maxWidth, font, fontSize) {
    if (!text) return [''];
    const words = String(text).split(/\s+/);
    const lines = [];
    let currentLine = '';

    words.forEach((word) => {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const width = font.widthOfTextAtSize(testLine, fontSize);
        if (width <= maxWidth) {
            currentLine = testLine;
        } else {
            if (currentLine) lines.push(currentLine);
            currentLine = word;
        }
    });

    if (currentLine) {
        lines.push(currentLine);
    }

    return lines.length ? lines : [''];
}

async function mergePdfBuffers(buffers = []) {
    const pdfBuffers = buffers.filter(Boolean);

    if (!pdfBuffers.length) {
        throw new Error('No PDF buffers provided for merging');
    }

    if (pdfBuffers.length === 1) {
        return pdfBuffers[0];
    }

    const mergedPdf = await PDFDocument.create();

    for (const buffer of pdfBuffers) {
        const document = await PDFDocument.load(buffer);
        const copiedPages = await mergedPdf.copyPages(document, document.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
    }

    return mergedPdf.save();
}

module.exports = { generateCustomLabelPdf, generateBagLabelPdf, mergePdfBuffers };
