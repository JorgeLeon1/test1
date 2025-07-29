from sanic import Sanic
from sanic.response import json
#from excel_handler import handle_excel_upload
from  hiLight_locations import highlight_warehouse
from sanic.response import json

app = Sanic("ExcelUploader")


@app.post("/upload-orders")
async def upload_orders(request):
    if 'file' not in request.files:
        return json({"error": "No file uploaded"}, status=400)

    file = request.files.get('file')
    #result, status = handle_excel_upload(file)
    return json(result, status=status)

@app.post("/hilight_location")
async def hilight_location(request):
    locations = request.json.get('highlightLocations')
    highlight_warehouse(locations, "./WM_warehouse.xlsx", "../public/WM1warehouse.xlsx")
    if not locations:
        return json({"error": "No highlight locations provided"}, status=400)
    return json({"message": "Locations highlighted successfully"}, status=200)
    
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)