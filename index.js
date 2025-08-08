import express from 'express';
import session from 'express-session';
// import bodyParser from 'body-parser'; // not needed (you already use express.json/urlencoded)
import multer from 'multer';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import fs from 'fs';
import connectToDatabase from './connectTodb.js';
import nodemailer from 'nodemailer';
import allocateOrders from './app/allocateOrder.js';
import axios from 'axios';

// 1) Load env FIRST
import dotenv from 'dotenv';
dotenv.config();

// 2) Create the Express app BEFORE using it
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));

// 3) Static files (so /public/*.html works)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static('public'));

// 4) Mount new Extensiv routes AFTER app exists
import extensiv from './app/routes/extensiv.js';
app.use('/extensiv', extensiv);

// 5) Quick health check
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- Session Configuration
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 30 * 60 * 10000 }, // 30 minutes
}));

// ---- Multer upload setup
const uploadDir = path.join(__dirname, 'Uploaded940s');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// ---- Helpers
function transformLocations(data) {
  const locations_to_highlight = {};
  data.forEach(item => {
    const sku = item.sku;
    (item.locations || []).forEach(location => {
      const locName = location.LocationIdentifier?.NameKey?.Name?.toLowerCase();
      if (!locName) return;
      const onHand = location.OnHand || 0;
      if (locations_to_highlight[locName]) {
        locations_to_highlight[locName].quantity += onHand;
      } else {
        locations_to_highlight[locName] = { sku, quantity: onHand };
      }
    });
  });
  return locations_to_highlight;
}

// ---- Routes
const users = [
  { username: 'YS', password: 'testCus1' },
  { username: 'mw', password: 'wmadmin' },
  { username: 'sw', password: 'wmadmin2' },
  { username: 'crystal', password: 'admin123' }
];

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    req.session.user = username;
    res.redirect('/portal');
  } else {
    res.status(401).send('Invalid username or password');
  }
});

// logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// auth middleware
function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/');
}

app.get('/landing', isAuthenticated, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'landing.html'))
);

app.get('/allocateOrders', isAuthenticated, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'allocateOrders.html'))
);

app.get('/order', isAuthenticated, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'order.html'))
);

app.get('/seeDatabaseData', isAuthenticated, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'seeDatabaseData.html'))
);

app.get('/portal', isAuthenticated, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'portal.html'))
);

app.get('/help', isAuthenticated, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'helpPage.html'))
);

app.get('/getOrdersPage', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'seeOrderlines.html'))
);

app.get('/orderReport', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'seeOrderHeadersAndLines.html'))
);

app.get('/reports', isAuthenticated, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'reportsLanding.html'))
);

app.get('/account', isAuthenticated, (_req, res) =>
  res.send('Coming soon! Here, you can edit your profile...')
);

// sample DB JSON route
app.get('/googleSpreadsheetorders', isAuthenticated, async (_req, res) => {
  try {
    const results = await connectToDatabase(`
      SELECT orderId as orderNum, gs.insertedDate as date_processed, c.customerName as customer, gs.success
      FROM OrdersSentToGoogleSheet gs
      INNER JOIN Customer c ON c.id = gs.customerId
    `);
    res.status(200).json(results);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving data from database');
  }
});

// misc routes
app.post('/submit-form', (req, res) => {
  console.log('Form Data:', req.body);
  res.send('Form submitted successfully');
});

app.post('/upload', upload.array('files', 3), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ message: 'No files uploaded' });
  const uploadedFiles = req.files.map(file => file.filename);
  res.json({ message: 'Files uploaded successfully', files: uploadedFiles });
});

app.post('/send-message', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ message: 'Message is required.' });

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'westmarkportal@wilenconsulting.com',
      pass: 'znlr wlej ikiy ladg' // consider env var
    }
  });

  const mailOptions = {
    from: '"Westmark Portal Contact Form" <westmarkportal@wilenconsulting.com>',
    to: 'support@wilenconsulting.com',
    cc: 'yael@wilenconsulting.com',
    subject: 'New Message from Wm Help Center',
    text: message
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Message sent successfully!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to send message.' });
  }
});

app.get('/check-session', (req, res) => {
  res.json({ loggedIn: !!req.session.user });
});

// legacy allocate route (your existing logic)
app.post('/allocateOrders', async (req, res) => {
  try {
    const lineIds = req.body.lineIds;
    const orderLines = await connectToDatabase(
      `SELECT * FROM OrderItems WHERE id IN (${lineIds.join(',')})`
    );

    const allocationResults = await allocateOrders(orderLines);
    const highlightLocations = transformLocations(allocationResults.allSkusAndLocations);

    // Example: send highlightLocations to Sanic
    const config = {
      method: 'post',
      url: `http://${process.env.SANIC_URL}/hilight_location`,
      headers: { 'Content-Type': 'application/json' },
      data: { highlightLocations }
    };
    const response = await axios.request(config);
    console.log(response.data);

    res.json(allocationResults.allocations);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error allocating orders');
  }
});

app.post('/forceAllocate', async (_req, res) => { res.sendStatus(204); });
app.post('/updateAllocation', async (_req, res) => { res.sendStatus(204); });
app.get('/seeAllAllocations', async (_req, res) => { res.sendStatus(204); });
app.post('/submitAllocations', async (_req, res) => { res.sendStatus(204); });

app.get('/getAllLocations', async (_req, res) => { res.sendStatus(204); });

app.get('/getAllOrders', async (_req, res) => {
  const results = await connectToDatabase(`
    SELECT c.customerName, oi.order_id, oi.sku, oi.qty
    FROM Orders_1 o
    INNER JOIN Customer c ON o.customer_id = c.id
    INNER JOIN OrderItems oi ON o.id = oi.order_id
  `);
  res.status(200).json(results);
});

// ---- process handlers
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

// ---- start server
const PORT = process.env.PORT || 3030;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${PORT}`);
});
