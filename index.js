import express from 'express';
import session from 'express-session';
import bodyParser from 'body-parser';
import multer from 'multer';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import fs from 'fs'
import connectToDatabase from './connectTodb.js';
import nodemailer from 'nodemailer';
import allocateOrders from './app/allocateOrder.js';
import axios from 'axios';
// import deotenv
import dotenv from 'dotenv';

dotenv.config();


const app = express();
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));

// Session Configuration
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 30 * 60 * 10000 }, // 30 minutes session timeout
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static('public'));

// Setup Multer for file uploads
const uploadDir = path.join(__dirname, "Uploaded940s");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir); // Save files in '940s' directory
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`); // Unique filename
    },
});

const upload = multer({ storage });
/* 
// SQL Server Configuration
const config = {
  user: 'YaelSchiff',
  password: 'mby2025@NY',
  server: '72.167.50.108',
  port: 1433,
  database: 'master',
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
};

 */
function transformLocations(data) { // hopefully this will be replaced with a real transform functiom
  const locations_to_highlight = {};

  data.forEach(item => {
    const sku = item.sku;

    item.locations.forEach(location => {
      const locName = location.LocationIdentifier?.NameKey?.Name?.toLowerCase();

      if (!locName) return;

      const onHand = location.OnHand || 0;

      // Accumulate quantity if location already exists
      if (locations_to_highlight[locName]) {
        locations_to_highlight[locName].quantity += onHand;
      } else {
        locations_to_highlight[locName] = {
          sku: sku,
          quantity: onHand,
        };
      }
    });
  });

  return locations_to_highlight;
}




const users = [{ username: 'YS', password: 'testCus1' }, 
  {username: 'mw', password: 'wmadmin'}, 
  {username: 'sw', password: 'wmadmin2'},
  {username: 'crystal', password: 'admin123'}];

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

//login endpoint
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

// Logout Endpoint
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Middleware to protect routes
function isAuthenticated(req, res, next) {
  if (req.session.user) {
    return next();
  }
  res.redirect('/');
}

app.get('/landing', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/allocateOrders', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'allocateOrders.html'));
});

app.get('/order', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

app.get('/seeDatabaseData', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'seeDatabaseData.html'));
});

app.get('/portal', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

app.get('/help', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'helpPage.html'));
});


app.get('/getOrdersPage', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'seeOrderlines.html'));
});

app.get('/orderReport', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'seeOrderHeadersAndLines.html'));
});


app.get('/reports', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reportsLanding.html'));
});

app.get('/account', isAuthenticated, (req, res) => {
  res.send('Coming soon! Here, you can edit your profile. Admins can add users and permissions, etc. Customized to each customer and user');
});


app.get('/googleSpreadsheetorders', isAuthenticated, async (req, res) => {
     try{
       const results = await connectToDatabase(`SELECT orderId as orderNum, 
        gs.insertedDate as date_processed, 
        c.customerName as customer,
        gs.success 
        from OrdersSentToGoogleSheet gs
        Inner join Customer c 
        On c.id = gs.customerId`);
        console.log('results!')
       console.log(results);
       res.status(200).json(results);
     }catch(err){
       console.error(err);
       res.status(500).send('Error retrieving data from database');
     } 
});


app.post('/submit-form', (req, res) => {
  console.log('Form Data:', req.body);
  res.send('Form submitted successfully');
});

app.post("/upload", upload.array("files", 3), (req, res) => {
  if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
  }

  const uploadedFiles = req.files.map(file => file.filename);
  res.json({ message: "Files uploaded successfully", files: uploadedFiles });
});


app.post('/send-message', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ message: 'Message is required.' });
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail', // or your preferred service
    auth: {
      user: 'westmarkportal@wilenconsulting.com',
      pass: 'znlr wlej ikiy ladg' // use an app password if using Gmail
    }
  });

  const mailOptions = {
    from: '"Westmark Portal Contact Form" <your.email@gmail.com>',
    to: 'support@wilenconsulting.com',
    c: 'yael@wilenconsulting.com',
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

// Auto logout on window close (client-side script needed)
app.get('/check-session', (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true });
  } else {
    res.json({ loggedIn: false });
  }
});


app.post('/allocateOrders', async (req, res) => {
  try {
    // get order lines from the request body
    const lineIds = req.body.lineIds;
    // we get the lines directly from the database, to ensure the most updated data
    const orderLines = await connectToDatabase(`SELECT * FROM OrderItems WHERE id IN (${lineIds.join(',')})`);
    console.log(orderLines);

    // send to allocate orders function
    const allocationResults =  await allocateOrders(orderLines);
    console.log(JSON.stringify(allocationResults.allSkusAndLocations));

    const highlightLocations = transformLocations(allocationResults.allSkusAndLocations);
    console.log('locations to highlight: ', highlightLocations);
    // sample to send to hi-light locations:
    /* locations_to_highlight = {
      '1-a-1': {'sku': 'sku1', 'quantity': 12},
      '10-a-2': {'sku': 'sku1', 'quantity': 12},
      '50-a-3': {'sku': 'sku1', 'quantity': 24},
      '2-a-4': {'sku': 'sku2', 'quantity': 10},
      '3-b-5': {'sku': 'sku2', 'quantity': 10},
      '4-c-6': {'sku': 'sku2', 'quantity': 10},
      '5-a-7': {'sku': 'sku2', 'quantity': 10}
    }*/
    // send to Sanic app (have it hosted as a .env)

    console.log(process.env);
    const config = {
      method: 'post',
      url: `http://${process.env.SANIC_URL}/hilight_location`,
      headers: {
        'Content-Type': 'application/json'
      },
      data: { highlightLocations }
    };

    const response = await axios.request(config);
    console.log(response.data); // handle the response from the Sanic app

    // if get a location back, send it to the client, and a message to show the visualize locations
    // also put the orders into temp table in the database
    // if not, send a message to the client showing the existing locations and allow them to choose
    res.json(allocationResults.allocations);
    console.log(req.body);
  } catch(err){
    console.error(err);
    res.status(500).send('Error allocating orders');
  }
}
)

app.post('/forceAllocate' , async (req, res) => {
  // add the order lines to the database
});

app.post('/updateAllocation', async (req, res) => {
  // use a merge to update allocations in the temp table
});

app.get('/seeAllAllocations', async(req, res) => {
  // get all temp allocations from the database and send to client
  });

app.post('/submitAllocations', async(req, res) => {
  // send all allocations into the database
});

app.get('/getAllLocations', async(req, res) => {
  // get all locations from extensiv and send to client
});

app.get('/getAllOrders', async(req, res) => {
  // get all orders from database and send to client (allow by customer)
  const results = await connectToDatabase(`SELECT c.customerName, oi.order_id, oi.sku, oi.qty FROM Orders_1 o INNER JOIN Customer c ON o.customer_id = c.id 
    INNER JOIN OrderItems oi ON o.id = oi.order_id`);
  console.log('results!')
  console.log(results);
  res.status(200).json(results);
});

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

const PORT = process.env.PORT || 3030;

app.listen(PORT, '0.0.0.0', () => {
  console.log('all running smoothly')
});

