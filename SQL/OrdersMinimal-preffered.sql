CREATE TABLE Orders_1 (
    id INT IDENTITY(1,1) PRIMARY KEY,
    customer_id INT NOT NULL,
    facility_id INT NOT NULL,
    reference_num VARCHAR(255),
    notes TEXT,
    shipping_notes TEXT,
    billing_code VARCHAR(50),
    carrier VARCHAR(50),
    mode VARCHAR(10),
    scac_code VARCHAR(10),
    account VARCHAR(50),
    shipto_company_name VARCHAR(255),
    shipto_name VARCHAR(255),
    shipto_address1 VARCHAR(255),
    shipto_address2 VARCHAR(255),
    shipto_city VARCHAR(100),
    shipto_state VARCHAR(50),
    shipto_zip VARCHAR(20),
    shipto_country VARCHAR(10)
);

CREATE TABLE OrderItems (
    id INT IDENTITY(1,1) PRIMARY KEY,
    order_id INT REFERENCES Orders_1(id),
    sku VARCHAR(100) NOT NULL,
    qty INT NOT NULL
);
