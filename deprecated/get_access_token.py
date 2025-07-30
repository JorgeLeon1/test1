import http.client
import json


def get_access_token():
    conn = http.client.HTTPSConnection("box.secure-wms.com")
    payload = json.dumps({
    "grant_type": "client_credentials",
    "user_login_id": "246" # we need a different one
    })
    headers = {
    'Host': 'box.secure-wms.com',
    'Connection': 'keep-alive',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': 'Basic YjFjZGZhNTktOGRkMS00ZDU1LTkyMjAtYTQxNWZlMWQ3OTIyOnNvRElmTjdXbENyQTJmVzdHYnNrcWRGZDNhWlVpcXQ3', #this is urlencoded clientid:client secret
    'Accept-Encoding': 'gzip,deflate,sdch',
    'Accept-Language': 'en-US,en;q=0.8'
    }
    conn.request("POST", "/AuthServer/api/Token", payload, headers)
    res = conn.getresponse()
    data = res.read()
    print(data.decode("utf-8"))

    return json.loads(data)


if __name__ == "__main__":
    get_access_token()
