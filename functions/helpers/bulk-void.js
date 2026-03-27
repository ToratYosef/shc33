function normalizeStatusValue(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeStatusList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => normalizeStatusValue(value))
    .filter(Boolean);
}

function filterOrdersForBulkVoidCandidates(
  orders = [],
  {
    orderIds = null,
    allowedStatuses = [],
    onlyStatus = null,
  } = {}
) {
  const allowedIdSet = Array.isArray(orderIds) && orderIds.length
    ? new Set(orderIds.map((value) => String(value || '').trim()).filter(Boolean))
    : null;
  const normalizedAllowedStatuses = new Set(normalizeStatusList(allowedStatuses));
  const normalizedOnlyStatus = normalizeStatusValue(onlyStatus);

  return (Array.isArray(orders) ? orders : []).filter((order) => {
    const orderId = String(order?.id || '').trim();
    if (!orderId) {
      return false;
    }

    if (allowedIdSet && !allowedIdSet.has(orderId)) {
      return false;
    }

    const normalizedStatus = normalizeStatusValue(order?.status);
    if (normalizedOnlyStatus && normalizedStatus !== normalizedOnlyStatus) {
      return false;
    }

    if (normalizedAllowedStatuses.size > 0 && !normalizedAllowedStatuses.has(normalizedStatus)) {
      return false;
    }

    return true;
  });
}

module.exports = {
  filterOrdersForBulkVoidCandidates,
};
