import http.client
import json

def get_locations():
    conn = http.client.HTTPSConnection("box.secure-wms.com")
    payload = ''
    headers = {
        'Host': 'box.secure-wms.com',
        'Authorization': 'Bearer b1cdfa59-8dd1-4d55-9220-a415fe1d7922',
    }


