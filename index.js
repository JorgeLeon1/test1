import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import session from 'express-session';
import multer from 'multer';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import fs from 'fs';
import nodemailer from 'nodemailer';
import axios from 'axios';

import connectToDatabase from './connectTodb.js';
import allocateOrders from './app/allocateOrder.js';

import allocRouter from "./app/routes/alloc.js";
import extensivRouter from "./app/routes/extensiv.js";

const app = express(); // ✅ Declare first

app.use("/extensiv", extensivRouter); // ✅ Mount routers after declaration
app.use("/alloc", allocRouter);



app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 30 * 60 * 10000 },
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// static assets
app.use(express.static('public'));

/* ------------------------------ Multer ------------------------------- */

const uploadDir = path.join(__dirname, 'Uploaded940s');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

/* --------------------------- Small helpers --------------------------- */

function transformLocations(data) {
  const locations_to_highlight = {};
  (data || []).forEach(item => {
    const sku = item.sku;
    (item.locations || []).forEach(location => {
      const locName = location?.LocationIdentifier?.NameKey?.Name?.toLowerCase();
      if (!locName) return;
      const onHand = location?.OnHand || 0;
      if (locations_to_highlight[locName]) {
        locations_to_highlight[locName].quantity += onHand;
      } else {
        locations_to_highlight[locName] = { sku, quantity: onHand };
      }
    });
  });
  return locations_to_highlight;
}

/* ------------------------------- Auth -------------------------------- */

const users = [
  { username: 'YS',      password: 'testCus1' },
  { username: 'mw',      password: 'wmadmin' },
  { username: 'sw',      password: 'wmadmin2' },
  { username: 'crystal', password: 'admin123' }
];

function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/');
}

/* ------------------------------- Views ------------------------------- */

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    req.session.user = username;
    return res.redirect('/portal');
  }
  res.status(401).send('Invalid username or password');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/landing',           isAuthenticated, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/allocateOrders',    isAuthenticated, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'allocateOrders.html')));
app.get('/order',             isAuthenticated, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'order.html')));
app.get('/seeDatabaseData',   isAuthenticated, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'seeDatabaseData.html')));
app.get('/portal',            isAuthenticated, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));
app.get('/help',              isAuthenticated, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'helpPage.html')));
app.get('/getOrdersPage',     isAuthenticated, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'seeOrderlines.html')));
app.get('/orderReport',       isAuthenticated, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'seeOrderHeadersAndLines.html')));
app.get('/reports',           isAuthenticated, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'reportsLanding.html')));

/* ------------------------------- API --------------------------------- */

app.get('/googleSpreadsheetorders', isAuthenticated, async (_req, res) => {
  try {
    const results = await connectToDatabase(`
      SELECT orderId as orderNum,
             gs.insertedDate as date_processed,
             c.customerName as customer,
             gs.success
      FROM OrdersSentToGoogleSheet gs
      INNER JOIN Customer c ON c.id = gs.customerId
    `);
    res.status(200).json(results);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving data from database');
  }
});

app.post('/submit-form', (req, res) => {
  console.log('Form Data:', req.body);
  res.send('Form submitted successfully');
});

app.post('/upload', upload.array('files', 3), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ message: 'No files uploaded' });
  const uploadedFiles = req.files.map(f => f.filename);
  res.json({ message: 'Files uploaded successfully', files: uploadedFiles });
});

app.post('/send-message', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ message: 'Message is required.' });

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: 'westmarkportal@wilenconsulting.com', pass: 'znlr wlej ikiy ladg' }
    });

    await transporter.sendMail({
      from: '"Westmark Portal Contact Form" <your.email@gmail.com>',
      to: 'support@wilenconsulting.com',
      c: 'yael@wilenconsulting.com',
      subject: 'New Message from Wm Help Center',
      text: message
    });

    res.status(200).json({ message: 'Message sent successfully!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to send message.' });
  }
});

app.get('/check-session', (req, res) => {
  res.json({ loggedIn: !!req.session.user });
});

/* ------------------------ Allocation endpoint ------------------------ */

app.post('/allocateOrders', async (req, res) => {
  try {
    const lineIds = req.body?.lineIds || [];
    if (!Array.isArray(lineIds) || !lineIds.length) {
      return res.status(400).json({ message: 'lineIds must be a non-empty array' });
    }

    // latest data from DB
    const orderLines = await connectToDatabase(
      `SELECT * FROM OrderItems WHERE id IN (${lineIds.map(Number).join(',')})`
    );

    const allocationResults = await allocateOrders(orderLines);
    const highlightLocations = transformLocations(allocationResults.allSkusAndLocations || []);

    // if you have a Sanic visualizer:
    if (process.env.SANIC_URL) {
      try {
        await axios.post(`http://${process.env.SANIC_URL}/hilight_location`, { highlightLocations }, {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        console.warn('Sanic highlight failed:', e.message);
      }
    }

    res.json(allocationResults.allocations || []);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error allocating orders');
  }
});

/* --------------------- Extensiv router (mount here) ------------------ */

app.use('/extensiv', extensivRouter);

/* --------------------------- Health & errors ------------------------- */

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// JSON error handler (avoid HTML error pages)
app.use((err, _req, res, _next) => {
  console.error('API error:', err);
  const status = err.status || err.response?.status || 500;
  res.status(status).json({
    ok: false,
    status,
    message: err.message,
    data: err.response?.data
  });
});

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

const PORT = process.env.PORT || 3030;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server listening on', PORT);
});
