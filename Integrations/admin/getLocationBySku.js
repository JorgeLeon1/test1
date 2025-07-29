import getAccessToken from "./getAccessToken.js";
import axios from "axios";

async function getLocationBySkus(sku) {
    // TODO: pagination

const access_token = await getAccessToken();
    // get the location by sku
let config = {
    method: 'get',
    maxBodyLength: Infinity,
    url: `https://secure-wms.com/inventory/facilities/2/locations?rql=ItemTraits.ItemIdentifier.Sku==${sku}`,
    headers: { 
        'Authorization': `Bearer ${access_token.access_token}`
    }
    };


    const response = await axios.request(config)

    return response.data.ResourceList;
}


export default getLocationBySkus;