const express = require('express');
const { refreshTracking, refreshTrackingBulkKit } = require('../../functions/index.js');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.post('/refresh-tracking', (req, res) => refreshTracking(req, res));
router.post('/refresh-tracking/bulk-kit', requireAdmin, (req, res) => refreshTrackingBulkKit(req, res));

module.exports = router;
