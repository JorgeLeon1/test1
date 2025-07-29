-- Create the orders table
CREATE TABLE orders (
    orderId INT PRIMARY KEY,
    referenceNum NVARCHAR(255),
    [description] NVARCHAR(255),
    poNum NVARCHAR(255),
    externalId NVARCHAR(255),
    earliestShipDate DATETIME,
    shipCancelDate DATETIME,
    notes NVARCHAR(255),
    numUnits1 FLOAT,
    unit1IdentifierId INT,
    numUnits2 FLOAT,
    unit2IdentifierId INT,
    totalWeight FLOAT,
    totalVolume FLOAT,
    billingCode NVARCHAR(255),
    asnNumber NVARCHAR(255),
    upsServiceOptionCharge FLOAT,
    upsTransportationCharge FLOAT,
    addFreightToCod BIT,
    upsIsResidential BIT,
    exportChannelIdentifierId INT,
    routePickupDate DATETIME,
    shippingNotes NVARCHAR(255),
    masterBillOfLadingId NVARCHAR(255),
    invoiceNumber NVARCHAR(255),
    createdDate DATETIME,
    createdByIdentifierId INT,
    lastModifiedDate DATETIME,
    lastModifiedByIdentifierId INT,
    [status] INT
);

-- Create a table for Customer Identifier (for foreign key reference in orders table)
CREATE TABLE customer_identifiers (
    id INT PRIMARY KEY,
    externalId NVARCHAR(255),
    [name] NVARCHAR(255)
);

-- Create a table for Facility Identifier (for foreign key reference in orders table)
CREATE TABLE facility_identifiers (
    id INT PRIMARY KEY,
    name NVARCHAR(255)
);

-- Create a table for the packages
CREATE TABLE packages (
    packageId INT PRIMARY KEY,
    orderId INT,
    packageTypeId INT,
    packageDefIdentifierName NVARCHAR(255),
    packageDefIdentifierId INT,
    [length] FLOAT,
    width FLOAT,
    height FLOAT,
    [weight] FLOAT,
    codAmount FLOAT,
    insuredAmount FLOAT,
    trackingNumber NVARCHAR(255),
    [description] NVARCHAR(255),
    createDate DATETIME,
    oversize BIT,
    cod BIT,
    ucc128 INT,
    cartonId NVARCHAR(255),
    label NVARCHAR(MAX),
    FOREIGN KEY (orderId) REFERENCES orders(orderId)
);

-- Create a table for the packages' contents (items in the package)
CREATE TABLE package_contents (
    packageContentId INT PRIMARY KEY,
    packageId INT,
    orderItemId INT,
    receiveItemId INT,
    orderItemPickExceptionId INT,
    qty FLOAT,
    lotNumber NVARCHAR(255),
    serialNumber NVARCHAR(255),
    expirationDate DATETIME,
    createDate DATETIME,
    FOREIGN KEY (packageId) REFERENCES packages(packageId)
);

-- Create a table for outbound serial numbers
CREATE TABLE outbound_serial_numbers (
    id INT PRIMARY KEY,
    orderId INT,
    sku NVARCHAR(255),
    qualifier NVARCHAR(255),
    serialNumber NVARCHAR(255),
    FOREIGN KEY (orderId) REFERENCES orders(orderId)
);

-- Create a table for Billing information (related to the order)
CREATE TABLE billing_charges (
    chargeId INT PRIMARY KEY,
    orderId INT,
    chargeType INT,  -- 1: Handling, 2: Storage, etc.
    subtotal FLOAT,
    FOREIGN KEY (orderId) REFERENCES orders(orderId)
);

-- Create a table for saved elements (key-value pairs)
CREATE TABLE saved_elements (
    elementId INT PRIMARY KEY,
    orderId INT,
    [name] NVARCHAR(255),
    [value] NVARCHAR(255),
    FOREIGN KEY (orderId) REFERENCES orders(orderId)
);

-- Create a table for shipping information
CREATE TABLE shipping_info (
    id INT PRIMARY KEY,
    orderId INT,
    companyName NVARCHAR(255),
    name NVARCHAR(255),
    title NVARCHAR(255),
    address1 NVARCHAR(255),
    address2 NVARCHAR(255),
    city NVARCHAR(255),
    state NVARCHAR(255),
    zip NVARCHAR(255),
    country NVARCHAR(255),
    phoneNumber NVARCHAR(255),
    emailAddress NVARCHAR(255),
    FOREIGN KEY (orderId) REFERENCES orders(orderId)
);

-- Create a table for parcel options (delivery confirmation, residential flag, etc.)
CREATE TABLE parcel_options (
    id INT PRIMARY KEY,
    orderId INT,
    deliveryConfirmationType NVARCHAR(255),
    deliveredDutyPaid FLOAT,
    dryIceWeight FLOAT,
    insuranceAmount FLOAT,
    insuranceType INT,
    internationalContentsType NVARCHAR(255),
    internationalNonDelivery NVARCHAR(255),
    residentialFlag BIT,
    saturdayDeliveryFlag BIT,
    FOREIGN KEY (orderId) REFERENCES orders(orderId)
);
