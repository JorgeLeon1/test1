def allocate_inventory(items, pallets, destinations):
    # Step 1: Sort items by pick frequency (ABC Analysis)
    items = sorted(items, key=lambda x: x['pick_frequency'], reverse=True)

    # Step 2: Assign locations based on item category, destination, and pallet optimization
    for index, item in enumerate(items):
        if item['pick_frequency'] > 80:  # High demand (A)
            item['location'] = assign_location(item, 'A', index, pallets, destinations)
        elif item['pick_frequency'] > 50:  # Medium demand (B)
            item['location'] = assign_location(item, 'B', index, pallets, destinations)
        else:  # Low demand (C)
            item['location'] = assign_location(item, 'C', index, pallets, destinations)

    # Step 3: Implement dynamic batching and clustering for nearby items
    order_batches = create_order_batches(items, destinations)
    for batch in order_batches:
        for i in range(len(batch) - 1):
            current_item = batch[i]
            next_item = batch[i + 1]
            # Assign similar location for items in same batch
            if need_clustering(current_item, next_item):
                cluster_items(current_item, next_item)

    return items

def assign_location(item, category, index, pallets, destinations):
    # Determine if partial pallet can be used
    partial_pallet_location = find_partial_pallet_location(item, pallets)
    if partial_pallet_location:
        return partial_pallet_location  # Assign from existing partial pallet

    # Step 1: Assign location based on category (A, B, C)
    if category == 'A':
        location = f"Row1-Column{index % 5 + 1}"  # Eye-level for A items
    elif category == 'B':
        location = f"Row2-Column{index % 5 + 1}"  # Middle rows for B items
    else:
        location = f"Row3-Column{index % 5 + 1}"  # Lower rows for C items

    # Step 2: Adjust for item destination to minimize travel distance
    location = adjust_for_destination(item, location, destinations)

    return location

def adjust_for_destination(item, location, destinations):
    # Adjust the item's location based on its destination
    # Example: if the destination is close to a specific area in the warehouse, adjust location accordingly
    destination = destinations.get(item['destination_id'])
    if destination and destination['preferred_zone']:
        location = f"{destination['preferred_zone']}-{location}"
    return location

def find_partial_pallet_location(item, pallets):
    # Check if a partial pallet exists for this item and has enough space
    for pallet in pallets:
        if pallet['item_id'] == item['id'] and pallet['remaining_space'] > item['quantity']:
            # Update the pallet's remaining space and return the location
            pallet['remaining_space'] -= item['quantity']
            return pallet['location']
    return None  # No partial pallet found, need to allocate a full pallet

def create_order_batches(items, destinations):
    # This function clusters items frequently picked together into batches based on their destination
    batches = cluster_logic(items)
    
    # Sort or adjust batches so that items with the same destination are grouped together
    for batch in batches:
        batch.sort(key=lambda x: x['destination_id'])
    
    return batches

def need_clustering(item1, item2):
    # Define the conditions for clustering items together
    return item1['category'] == item2['category'] or item1['destination_id'] == item2['destination_id']

def cluster_items(item1, item2):
    # Update their location to be close to each other
    item1['location'] = item2['location']

# Example destinations data
destinations = {
    1: {'preferred_zone': 'North'},
    2: {'preferred_zone': 'South'},
    3: {'preferred_zone': 'East'}
}
