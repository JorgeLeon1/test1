import axios from 'axios';
import getAccessToken from './getAccessToken';


let config = {
  method: 'get',
  maxBodyLength: Infinity,
  url: 'https://secure-wms.com/properties/facilities/locations?pgnum=45', // TODO: make this dynamic. Add pagination
  headers: { 
    'Host': 'secure-wms.com', 
    'Content-Type': 'application/json; charset=utf-8', 
    'Accept': 'application/hal+json', 
    'Authorization': `Bearer ${await (getAccessToken()).access_token}`,
  }
};

axios.request(config)
.then((response) => {
  console.log(JSON.stringify(response.data));
  // write it to a file
  // TODO: python code will pick up the file and import it. Maybe call it here as an API?
  // this only happens once in a while? On trigger? Same with orders....
})
.catch((error) => {
  console.log(error);
});

// to get inventory. has a location, which can be foreign key to location table
/* curl --location -g 'https://secure-wms.com/inventory?pgsiz={{pgsiz}}&pgnum={{pgnum}}&rql={{RQLparams}}&sort={{seeSort}}&senameorvaluecontains={{senameorvaluecontains}}' \
--header 'Accept-Language: en-US,en;q=0.8' \
--header 'Host: secure-wms.com' \
--header 'Content-Type: application/json; charset=utf-8' \
--header 'Accept: application/hal+json' \
--header 'Authorization: Bearer {{Enter_Access_Token_Here}}' */