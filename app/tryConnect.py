import pyodbc

print(pyodbc.drivers())

# Define your SQL Server details
server = '72.167.50.108'
database = 'master'
username = 'YaelSchiff'
password = 'mby2025@NY'
port = '1433'  # Default SQL Server Port

# Connection string
conn_str = f'DRIVER=ODBC Driver 18 for SQL Server;SERVER={server},{port};DATABASE={database};UID={username};PWD={password};Encrypt=yes;TrustServerCertificate=yes;'

# Connect to SQL Server
def connect_sql(query):
    try:
        conn = pyodbc.connect(conn_str)
        cursor = conn.cursor()
        
        # Test query
        cursor.execute(query)
        cursor.commit()
        
        # Close connection
        cursor.close()
        conn.close()
    except Exception as e:
        print("Error connecting to SQL Server:", e)

if __name__ == '__main__':
    with open ('C:\\Users\\Owner\\westmarkPortal\\SQL\\OrdersMinimal-preffered.sql', 'r') as file:
        query = file.read()
    print(query)
    connect_sql(query)