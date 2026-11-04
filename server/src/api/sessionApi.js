import express from 'express';
import { login, logout, whoami, requireSession } from '../security/session.js';

export const sessionApi = express.Router();

sessionApi.post('/auth/login', login);
sessionApi.post('/auth/logout', logout);
sessionApi.get('/auth/me', requireSession, whoami);
