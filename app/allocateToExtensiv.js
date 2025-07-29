/*
Gets an order
for each orderline
set the priority of the desired locations
use an index, setting higher to lower priority in order of how to locations should allocate (all full pallets can be 1, and partial pallet 2, and so on)
use the location id to set the priority in extensiv
sends that it was successful to the client
*/

// client posts the order and waits for a success. The order is immediately allocated in extensiv. (Check if needs a delay just in case)
// then client calls reset priority

/*
 gets a list of locations
 sets all priorities back to original (9999)
 returns success
 */
