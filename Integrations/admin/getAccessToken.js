import axios from "axios";


async function getAccessToken(loginId = 0, clientCredentials = 'MTdiZjc4NzYtNThhNy00YzBkLTgzMmEtNjAzNmMxNWEwNWE3Olk1SFdFSVMxZUdQUjdMb3YyUS9MbGNiZ3NPc3Z5anhS') {
let data = JSON.stringify({
  "grant_type": "client_credentials",
  "user_login_id": loginId
});

let config = {
  method: 'post',
  maxBodyLength: Infinity,
  url: 'https://secure-wms.com/AuthServer/api/Token',
  headers: { 
    'Host': 'secure-wms.com', 
    'Connection': 'keep-alive', 
    'Content-Type': 'application/json', 
    'Accept': 'application/json', 
    'Authorization': `Basic ${clientCredentials}`, 
    'Accept-Encoding': 'gzip,deflate,sdch', 
    'Accept-Language': 'en-US,en;q=0.8'
  },
  data : data
};

const response = await axios.request(config)

return response.data

}

export default getAccessToken;

