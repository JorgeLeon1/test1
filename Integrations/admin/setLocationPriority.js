import axios from "axios";
import getAccessToken from "./getAccessToken.js";

async function getForTag(locationId) {
    let config = {
        method: 'get',
        maxBodyLength: Infinity,
        url: `https://secure-wms.com/properties/facilities/2/locations/${locationId}`,
        headers: { 
          'Authorization': `Bearer ${await getAccessToken().access_token}`, 
          'Content-Type': 'application/json'
        },
      };
      
    const response = await axios.request(config)

    return {origData: response.data, Etag: response.headers.ETag}
}



async function setLocationPriority(priority, locationId) {
   const {origData, Etag} = await getForTag(locationId);
   origData.AllocationPriority = priority
    let data = JSON.stringify(origData);

    let config = {
    method: 'put',
    maxBodyLength: Infinity,
    url: `https://secure-wms.com/properties/facilities/2/locations/${locationId}`,
    headers: { 
        'Authorization': `Bearer ${await getAccessToken().access_token}`, 
        'If-Match':`'${Etag}'`, 
        'Content-Type': 'application/json'
    },
    data : data
    };


    const response = await axios.request(config)

    return response.status;
}

export default setLocationPriority;

