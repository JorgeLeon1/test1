import axios  from "axios";


let data = JSON.stringify({
  "allocationPriority": 1,
  "Field1": "to control allocation"
});

let config = {
  method: 'put',
  maxBodyLength: Infinity,
  url: 'https://secure-wms.com/properties/facilities/2/locations/30241',
  headers: { 
    'Authorization': 'Bearer eyJ0eXAiOiJqd3QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOiIxNzQzNTI5NjgwIiwiaXNzIjoiaHR0cHM6Ly8zdy5leHRlbnNpdi5jb20vYXV0aHNlcnZlciIsImF1ZCI6Imh0dHA6Ly8iLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJjdXN0b21lcnZpZXcgZmFjaWxpdHl2aWV3IGludmVudG9yeWRldGFpbHZpZXcgaXRlbXZpZXcgb3JkZXJlZGl0IG9yZGVydmlldyBvcmRlcndyaXRlIHJlYWRwcm9wZXJ0aWVzdGhpcmRwYXJ0eSByZWNlaXZlcnZpZXcgZmFjaWxpdHllZGl0IiwiaHR0cDovL3d3dy4zcGxDZW50cmFsLmNvbS9BdXRoU2VydmVyL2NsYWltcy91c2VyaW5mbyI6ImV5SkRiR2xsYm5SSlpDSTZNVGt5TWpBc0lrTnNhV1Z1ZENJNklsQnliM1pwYzJsdmJtVmtJR0o1SUVwaGJpQlVZWGxzYnlCbWIzSWdRV3hzSUdOMWMzUnZiV1Z5Y3lCdmJpQXlNREkxTHpBekx6QTJJQ2gxYzJsdVp5QkVRVkpVS1M0aUxDSlVhSEpsWlZCc1IzVnBaQ0k2SW1FMk1qYzFaRFV6TFdFNFl6TXRORFV6WkMxaVlURmlMV1l4TmpBNFpUazNPRFkxWVNJc0lsUm9jbVZsVUd4SlpDSTZNekE0T0N3aVZYTmxja3h2WjJsdVNXUWlPakI5In0.dhrxz8qVmarEwp3BTkWIfUWEIcNHYSKJKsDmFn8TNzE', 
    'If-Match': ' "AAAAAADlChg"', 
    'Content-Type': 'application/json'
  },
  data : data
};

axios.request(config)
.then((response) => {
  console.log(JSON.stringify(response.data));
})
.catch((error) => {
  console.log(error);
});

