/*
 - call: run logic with visual
  - function takes order object
  - oterates over lines

     - for each line
      - getLocationBysku
      - spawn highlight locations and quantities with the object [format here for now] using excel file copy
      - find highest quantity and assume that a full pallet for now
      - decide if quantity ordered is a full or partial pallet
       - if full
          - map for  pallets in A\
          - if there is more than one pallet in A, map for full ones
            - find pallet with highest  number shelf
          - else, map for pallets in B
          - same logic as above then

      -  
      - send logic string (append throughout) and result to index to render to html. Include loc id and name
        
    
*/

import { all } from 'axios';
import { getLocationBySkus } from '../Integrations/integrationsUtil.js';

let allSkusAndLocations = [];
let allAllocations = [];
let unallocatedOrderLines = [];
 
async function allocateOrders(orderLines){
try{
  const allSkus = orderLines.map(orderLine => orderLine.sku);
  for (const sku of allSkus) {
    const skuExists = allSkusAndLocations.some(obj => obj.sku === sku);

    if (!skuExists) {
    // get location by sku
    let locations = await getLocationBySkus(sku);
    // format
    allSkusAndLocations.push({
      sku: sku,
      locations: locations
    });
    }
  }

  let localLocationsCopy = JSON.parse(JSON.stringify(allSkusAndLocations));


  // TODO: group orderlined by sku, and get locations once per sku.
  for (const orderLine of orderLines) {
    // get location by sku
    let locations = localLocationsCopy.find(sku => sku.sku === orderLine.sku).locations;

    let leftToOrder = orderLine.qty;

    // find the location where the 'onHand' field has the highest value
    let fullpallet = locations.sort((a, b) => b.OnHand - a.OnHand)[0].OnHand;
    while (leftToOrder>0) {
    if (locations.length == 0) {
      // no locations available, break out of the loop
      unallocatedOrderLines.push({
        sku: orderLine.sku,
        locations: locations,
        quantity: leftToOrder,
        message: 'No locations available for allocation'
      });
      break;
    }

    if (leftToOrder > fullpallet) {
      let allocated = false;
       // let fullPalletOnA = locations.filter(location => location.shelf === 'A' && location.onHand == fullpallet); // no actual location.shelf
       let shelfIndexMap = ['A1', 'A', 'A2', 'B', 'C', 'D', 'E'];
          // find the location with the lowest shelf
         for (let i = 0; i < shelfIndexMap.length; i++) {
           let shelf = shelfIndexMap[i];
           // get all full pallets on this shelf
           let palletOnShelf = locations.filter(location => (location.LocationIdentifier.NameKey.Name).split('-')[1] === shelf && location.OnHand == fullpallet); // this extracts the shelf from the location name
           // Only consider A if there are 2 full pallets
           if (shelf.includes('A') && palletOnShelf.length < 2) continue;
           if (palletOnShelf.length > 0) {
            // find the highest number shelf
             palletOnShelf.sort((a, b) => (b.LocationIdentifier.NameKey.Name).split('-')[2] - (a.LocationIdentifier.NameKey.Name).split('-')[2]); // this extracts the bin from the location name
             // allocate the full pallet to the order line
             allAllocations.push({
               sku: orderLine.sku,
               locationId: palletOnShelf[0].LocationIdentifier.Id,
               locationName: palletOnShelf[0].LocationIdentifier.NameKey.Name,
               quantity: fullpallet
             });
             allocated = true;
             leftToOrder -= fullpallet;
             // remove the location from the list of available locations
              locations = locations.filter(location => location.LocationIdentifier.Id !== palletOnShelf[0].LocationIdentifier.Id);

             break;
           }
         }

         // TODO: if no full pallets found, check for partial pallets and consolidate to full pallet? Give notice first though, so mark unallocated, and then offer to consolidate
         if(!allocated) {
          unallocatedOrderLines.push({
            sku: orderLine.sku,
            locations: locations,
            quantity: leftToOrder,
            message: 'No full pallets available for allocation. Please consolidate or wait for replenishment'
         })
         break;
         }
    } else {
      let palletFoundOnA = false;
      // look for  a partial pallet on A with a quantity greater than the order line quantity
      let partialPalletOnA = locations.filter(location => 
        (location.LocationIdentifier.NameKey.Name).split('-')[1].includes('A') &&
        location.OnHand > leftToOrder &&
        location.OnHand < fullpallet
      );
        if (partialPalletOnA.length > 0) {
        // find the pallet with the least amount over the order line quantity
        partialPalletOnA.sort((a, b) => a.OnHand - b.OnHand);
        // TODO - prioritize A1 locations

        allAllocations.push({
          sku: orderLine.sku,
          locationId: partialPalletOnA[0].LocationIdentifier.Id,
          locationName: partialPalletOnA[0].LocationIdentifier.NameKey.Name,
          quantity: leftToOrder
        });
        // remove the location from the list of available locations
        if (leftToOrder == partialPalletOnA[0].OnHand) {
           locations = locations.filter(location => location.LocationIdentifier.Id !== partialPalletOnA[0].LocationIdentifier.Id); 
        } else {
          // reduce the quantity on the location by the order line quantity
          locations = locations.map(location => {
            if (location.LocationIdentifier.Id === partialPalletOnA[0].LocationIdentifier.Id) {
              location.OnHand -= leftToOrder;
            }
            return location;
          });
        }

        palletFoundOnA = true;
        leftToOrder = 0; // exit loop as we have allocated the order line

      } else {
        // open a new pallet on A (if exists)
        let newPalletOnA = locations.filter(location => (location.LocationIdentifier.NameKey.Name).split('-')[1].includes('A')  && location.OnHand == fullpallet);
        if (newPalletOnA.length > 0) {
          allAllocations.push({
            sku: orderLine.sku,
            locationId: newPalletOnA[0].LocationIdentifier.Id,
            locationName: newPalletOnA[0].LocationIdentifier.NameKey.Name,
            quantity: leftToOrder
          });
          // remove the location from the list of available locations
          locations = locations.filter(location => location.LocationIdentifier.Id  !== newPalletOnA[0].LocationIdentifier.Id);
          palletFoundOnA = true;
        }
        leftToOrder = 0; // exit loop as we have allocated the order line
      }
      if (!palletFoundOnA) {
        // on false, send a message that this order will wait for replenishment or consolidation unless user says to force allocate
         unallocatedOrderLines.push({
          sku: orderLine.sku,
          locations: locations,
          quantity: leftToOrder,
          message: 'No locations available for allocation on shelf A for a partial pallet with sufficient quantity. please force allocate or consolidate pallets or wait for replenishment'
        });
      }
    }

  }


  // replace the locations in localLocationsCopy with the modified location object
   localLocationsCopy = localLocationsCopy.map(location => {
      if (location.sku === orderLine.sku) {
        location.locations = locations;
      }
      return location;
    });

  }

  return {
    allSkusAndLocations,
    localLocationsCopy,
    allocations: allAllocations,
    unallocatedOrderLines: unallocatedOrderLines
  };

}
  catch (error) {
    console.error('Error allocating orders:', error);
    throw error; // rethrow the error to be handled by the caller
  }
}

/*
 call allocate to this location
  // send back location id

  setpriority location with loc id(this can also happen in the index)
 
*/

/*let allresults = await allocateOrders([
  {
    customerName: 'Oline',
    order_id: 1,
    sku: 'OLN-ERGOACE-CRM',
    qty: 25
  },
  {
    customerName: 'Oline',
    order_id: 1,
    sku: 'OLN-ERGOAIR-BLK',
    qty: 15
  },
  {
    customerName: 'Oline',
    order_id: 2,
    sku: 'OLN-ERGOACE-CRM',
    qty: 50
  },
  {
    customerName: 'Oline',
    order_id: 2,
    sku: 'OLN-EC-BLK-1PK',
    qty: 30
  },
  {
    customerName: 'Oline',
    order_id: 3,
    sku: 'OLN-EC-BLK-1PK',
    qty: 40
  },
  {
    customerName: 'Oline',
    order_id: 4,
    sku: 'OLN-ERGOAIR-BLK',
    qty: 45
  },
  {
    customerName: 'Oline',
    order_id: 4,
    sku: 'OLN-ERGOACE-CRM',
    qty: 20
  }
])


console.log(JSON.stringify(allresults, null, 2));*/
export default allocateOrders;