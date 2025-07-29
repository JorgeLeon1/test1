import axios from "axios";
import getAccessToken from "./getAccessToken.js";


async function postOrder(order) {
    let data = order;
    let config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: 'https://secure-wms.com/orders',
    headers: { 
        'Content-Type': 'application/json; charset=utf-8', 
        'Accept': 'application/hal+json', 
        'Authorization': `Bearer ${await getAccessToken().access_token}`, 
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
}


export default postOrder;