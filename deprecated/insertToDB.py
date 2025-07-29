import json
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

# Database connection setup
DATABASE_URL = "mssql+pyodbc://your_username:your_password@your_server/your_database?driver=ODBC+Driver+17+for+SQL+Server"
engine = create_engine(DATABASE_URL)
Session = sessionmaker(bind=engine)
session = Session()

# JSON data (replace with actual JSON input)
json_data = [
    {
        "ReadOnly": {
            "OrderId": 10,
            "ProcessDate": "2021-04-15T18:43:29.81",
            "CreationDate": "2021-04-08T17:01:22.773",
            "LastModifiedDate": "2021-04-15T18:43:29.81",
            "CustomerIdentifier": {"Id": 5, "Name": "Tk S Gadgets LLC"},
            "FacilityIdentifier": {"Id": 1, "Name": "Bar Harbor"},
            "CreatedByIdentifier": {"Id": 2},
            "LastModifiedByIdentifier": {"Id": 2},
            "Status": 2
        },
        "ReferenceNum": "FBA161506Z6J-CANCELED-10",
        "EarliestShipDate": "2021-03-18T12:00:01",
        "Notes": "Reason for cancellation: Redo",
        "TotalWeight": 6187.5000,
        "TotalVolume": 687.4875,
        "BillingCode": "Prepaid",
        "AddFreightToCod": False,
        "UpsIsResidential": False
    }
]

# Insert data into tables
for order in json_data:
    read_only = order["ReadOnly"]
    
    # Insert Customer Identifier
    session.execute(text("""
        MERGE INTO customer_identifiers AS target
        USING (SELECT :id AS id, :name AS name) AS source
        ON target.id = source.id
        WHEN MATCHED THEN UPDATE SET name = source.name
        WHEN NOT MATCHED THEN INSERT (id, name) VALUES (source.id, source.name);
    """), {"id": read_only["CustomerIdentifier"]["Id"], "name": read_only["CustomerIdentifier"].get("Name", "")})
    
    # Insert Facility Identifier
    session.execute(text("""
        MERGE INTO facility_identifiers AS target
        USING (SELECT :id AS id, :name AS name) AS source
        ON target.id = source.id
        WHEN MATCHED THEN UPDATE SET name = source.name
        WHEN NOT MATCHED THEN INSERT (id, name) VALUES (source.id, source.name);
    """), {"id": read_only["FacilityIdentifier"]["Id"], "name": read_only["FacilityIdentifier"].get("Name", "")})
    
    # Insert Order
    session.execute(text("""
        INSERT INTO orders (
            orderId, referenceNum, earliestShipDate, notes, totalWeight, totalVolume,
            billingCode, addFreightToCod, upsIsResidential, createdDate, createdByIdentifierId,
            lastModifiedDate, lastModifiedByIdentifierId, [status]
        )
        VALUES (:orderId, :referenceNum, :earliestShipDate, :notes, :totalWeight, :totalVolume,
                :billingCode, :addFreightToCod, :upsIsResidential, :createdDate, :createdByIdentifierId,
                :lastModifiedDate, :lastModifiedByIdentifierId, :status)
        ON DUPLICATE KEY UPDATE 
            referenceNum = VALUES(referenceNum),
            earliestShipDate = VALUES(earliestShipDate),
            notes = VALUES(notes),
            totalWeight = VALUES(totalWeight),
            totalVolume = VALUES(totalVolume),
            billingCode = VALUES(billingCode),
            addFreightToCod = VALUES(addFreightToCod),
            upsIsResidential = VALUES(upsIsResidential),
            lastModifiedDate = VALUES(lastModifiedDate),
            lastModifiedByIdentifierId = VALUES(lastModifiedByIdentifierId),
            status = VALUES(status);
    """), {
        "orderId": read_only["OrderId"],
        "referenceNum": order["ReferenceNum"],
        "earliestShipDate": order["EarliestShipDate"],
        "notes": order["Notes"],
        "totalWeight": order["TotalWeight"],
        "totalVolume": order["TotalVolume"],
        "billingCode": order["BillingCode"],
        "addFreightToCod": order["AddFreightToCod"],
        "upsIsResidential": order["UpsIsResidential"],
        "createdDate": read_only["CreationDate"],
        "createdByIdentifierId": read_only["CreatedByIdentifier"]["Id"],
        "lastModifiedDate": read_only["LastModifiedDate"],
        "lastModifiedByIdentifierId": read_only["LastModifiedByIdentifier"]["Id"],
        "status": read_only["Status"]
    })

# Commit and close session
session.commit()
session.close()

print("Data inserted successfully!")
