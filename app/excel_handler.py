import os
import pandas as pd
import json
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy import text
from database import SessionLocal
from orders import Order

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# These are the internal field names expected by the database
REQUIRED_FIELDS = [
    'customer_id', 'facility_id', 'reference_num', 'notes', 'shipping_notes',
    'billing_code', 'carrier', 'mode', 'scac_code', 'account',
    'shipto_company_name', 'shipto_name', 'shipto_address1', 'shipto_address2',
    'shipto_city', 'shipto_state', 'shipto_zip', 'shipto_country',
    'sku', 'qty'
]

def is_valid_sku(sku, session):
    result = session.execute(
        text("SELECT 1 FROM dbo.Products WHERE sku = :sku"), {"sku": sku}
    ).first()
    return result is not None

def handle_excel_upload(file, mapping_json):
    filename = file.name
    filepath = os.path.join(UPLOAD_FOLDER, filename)

    with open(filepath, 'wb') as f:
        f.write(file.body)

    try:
        df = pd.read_excel(filepath)
    except Exception as e:
        return {"error": f"Error reading Excel: {str(e)}"}, 400

    try:
        mappings = json.loads(mapping_json)
        header_map = mappings.get('headerMapping', {})
        line_map = mappings.get('lineMapping', {})
    except Exception as e:
        return {"error": f"Invalid mapping format: {str(e)}"}, 400

    # Combine both mappings
    full_mapping = {**header_map, **line_map}

    # Ensure all required fields are mapped
    unmapped_fields = [field for field in REQUIRED_FIELDS if field not in full_mapping]
    if unmapped_fields:
        return {"error": f"Missing mappings for: {', '.join(unmapped_fields)}"}, 400

    # Ensure all mapped columns exist in Excel
    missing_columns = [full_mapping[f] for f in REQUIRED_FIELDS if full_mapping[f] not in df.columns]
    if missing_columns:
        return {"error": f"Missing columns in Excel: {', '.join(missing_columns)}"}, 400

    # Rename columns to match expected fields
    df_renamed = df.rename(columns={v: k for k, v in full_mapping.items()})

    session = SessionLocal()
    inserted = 0
    skipped = 0

    try:
        for _, row in df_renamed.iterrows():
            try:
                if not is_valid_sku(row['sku'], session):
                    print(f"Skipping row with invalid SKU: {row['sku']}")
                    skipped += 1
                    continue

                order = Order(
                    customer_id=int(row['customer_id']),
                    facility_id=int(row['facility_id']),
                    reference_num=row.get('reference_num'),
                    notes=row.get('notes'),
                    shipping_notes=row.get('shipping_notes'),
                    billing_code=row.get('billing_code'),
                    carrier=row.get('carrier'),
                    mode=row.get('mode'),
                    scac_code=row.get('scac_code'),
                    account=row.get('account'),
                    shipto_company_name=row.get('shipto_company_name'),
                    shipto_name=row.get('shipto_name'),
                    shipto_address1=row.get('shipto_address1'),
                    shipto_address2=row.get('shipto_address2'),
                    shipto_city=row.get('shipto_city'),
                    shipto_state=row.get('shipto_state'),
                    shipto_zip=row.get('shipto_zip'),
                    shipto_country=row.get('shipto_country')
                )
                session.add(order)
                inserted += 1
            except Exception as row_error:
                print(f"Skipping row due to error: {row_error}")
                skipped += 1
                continue

        session.commit()
    except SQLAlchemyError as e:
        session.rollback()
        return {"error": f"Database error: {str(e)}"}, 500
    finally:
        session.close()

    return {
        "message": f"{inserted} orders inserted into Orders_1",
        "skipped": skipped
    }, 200
