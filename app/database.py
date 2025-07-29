from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Connecting to server using SQLAlchemy
DATABASE_URL = "mssql+pyodbc://YaelSchiff:mby2025@NY@72.167.50.108:1433/master?driver=ODBC+Driver+18+for+SQL+Server&Encrypt=yes&TrustServerCertificate=yes"

engine = create_engine(DATABASE_URL)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
