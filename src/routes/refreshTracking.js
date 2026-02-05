const express = require('express');
const { refreshTracking } = require('../../functions/index.js');

const router = express.Router();

router.post('/refresh-tracking', (req, res) => refreshTracking(req, res));

module.exports = router;
