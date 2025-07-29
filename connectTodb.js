// Import the mssql package
// onst sql = require('mssql');
import sql from 'mssql';

// Define the configuration object for your SQL Server
const config = {
  user: 'YaelSchiff',       // Your SQL Server username
  password: 'mby2025@NY',   // Your SQL Server password
  server: '72.167.50.108',         // The SQL Server instance (can be an IP address or domain)
  port: 1433,
  database: 'master',   // The name of the database you want to connect to
  options: {
    encrypt: true,             // Use encryption
    trustServerCertificate: true // Set to true for local dev environments (self-signed certificates)
  }
};

// Function to connect to SQL Server and run a simple query
async function connectToDatabase(query) {
  try {
    // Connect to the SQL Server using the configuration
    await sql.connect(config);

    // Example query to test the connection
    const result = await sql.query(query);
    console.log(result.recordset);  // Output the query result
    return result.recordset; // Return the result for further processing

  } catch (err) {
    console.error('Error connecting to SQL Server:', err);
  } finally {
    // Close the connection after the query
    await sql.close();
  }
}

// Call the function to connect to the database
// await connectToDatabase();
export default connectToDatabase;