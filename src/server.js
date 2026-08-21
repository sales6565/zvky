require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const assetRoutes = require('./routes/assets');
const userRoutes = require('./routes/users');
const teamRoutes = require('./routes/team');

const app = express();

app.use(helmet({ contentSecurityPolicy: false })); // CSP left off for the bundled demo frontend; tighten if you serve it elsewhere
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*' }));
app.use(express.json());

// Slow down brute-force login attempts.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });
app.use('/api/auth/login', loginLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/users', userRoutes);
app.use('/api/team', teamRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve the bundled frontend
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Fallback error handler — surfaces the actual message (e.g. multer's file-type
// or size-limit errors) rather than a generic 500, since those are meant for the user.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Unexpected server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Zvky backend listening on http://localhost:${PORT}`);
});
