// Notification preference routes.
// Mounted under /api/v1/notifications/*

import express from "express";
import { sendError } from "../../lib/apiErrors.js";
import {
  getPreferences,
  updatePreferences,
  getNotificationLogs,
} from "./notification.service.js";

export const notificationRouter = express.Router();

const BASE = "/api/v1/notifications";

// GET preferences
notificationRouter.get(`${BASE}/preferences`, async (req, res, next) => {
  try {
    const prefs = await getPreferences(req.user.id);
    res.json({ preferences: prefs });
  } catch (err) {
    next(err);
  }
});

// PUT preferences
notificationRouter.put(`${BASE}/preferences`, async (req, res, next) => {
  try {
    const { emailEnabled, smsEnabled, phone, preferences } = req.body;
    const data = {};
    if (typeof emailEnabled === "boolean") data.emailEnabled = emailEnabled;
    if (typeof smsEnabled === "boolean") data.smsEnabled = smsEnabled;
    if (phone !== undefined) data.phone = phone || null;
    if (preferences && typeof preferences === "object") data.preferences = preferences;

    const updated = await updatePreferences(req.user.id, data);
    res.json({ preferences: updated });
  } catch (err) {
    next(err);
  }
});

// GET logs
notificationRouter.get(`${BASE}/logs`, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const logs = await getNotificationLogs(req.user.id, { limit, offset });
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});
