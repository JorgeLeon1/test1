import http.client
import json

def get_locations():
    conn = http.client.HTTPSConnection("secure-wms.com")
    payload = ''
    headers = {
        'Host': 'secure-wms.com',
        'Authorization': 'Bearer 2b1f6f6e-2f5c-4d5b-8b3b-3b3b3b3b3b3b',
    }


