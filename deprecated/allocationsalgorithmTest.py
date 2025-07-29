
from hiLightLocations import highlight_warehouse

def shelf_to_numeric(shelf):
    """
    Converts shelf letter (e.g., 'a') to a numeric value (e.g., 1 for 'a').
    """
    return ord(shelf.lower()) - ord('a') + 1

def calculate_distance(loc1, loc2):
    """
    Calculates the Manhattan distance between two locations.
    loc1 and loc2 are dictionaries containing 'rack', 'shelf', and 'bin' keys.
    """
    # Convert shelf to numeric values for comparison
    loc1_shelf = shelf_to_numeric(loc1['shelf'])
    loc2_shelf = shelf_to_numeric(loc2['shelf'])
    
    # Manhattan distance is the sum of absolute differences of each coordinate
    return abs(loc1['rack'] - loc2['rack']) + abs(loc1_shelf - loc2_shelf) + abs(loc1['bin'] - loc2['bin'])

def get_best_route(orders, locations):
    """
    Returns the best picking route based on the order quantities and location availability.
    
    Parameters:
    orders (dict): Contains SKU and quantity for each order.
    locations (dict): Contains location details (rack, shelf, bin) and available quantities for each SKU.
    
    Returns:
    list: A list of locations in the order they should be picked, prioritized by distance and quantity.
    """
    
    # Initialize an empty list to store the best picking route
    best_route = []
    
    # Sort locations based on rack, shelf, and bin numbers to prioritize lower values
    sorted_locations = sorted(locations.items(), key=lambda x: (x[1]['rack'], x[1]['shelf'], x[1]['bin']))

    print('Sorted Locations:', sorted_locations)

    # Loop through each order
    for sku, order_quantity in orders.items():
        
        # Find locations that have the SKU in stock and sort them by closest distance and availability
        available_locations = [
            (loc_id, loc) for loc_id, loc in sorted_locations if loc['sku'] == sku and loc['quantity'] > 0
        ]

        print(f"Available locations for SKU '{sku}':", available_locations)
        
        # Track remaining quantity for this SKU that needs to be picked
        remaining_quantity = order_quantity

        # Calculate best route for the SKU based on proximity, prioritizing partial pallets
        locations_to_pick = []
        for loc_id, loc in available_locations:
            if remaining_quantity == 0:
                break

            # If the location has less than a full pallet, prioritize it for partial pallets
            if loc['quantity'] < 24 and remaining_quantity < 24:
                locations_to_pick.append((loc, 'partial', calculate_distance(loc, locations[1])))  # Use a reference location (first location as an example)
            elif loc['quantity'] == 24:
                locations_to_pick.append((loc, 'full', calculate_distance(loc, locations[1])))

        # Sort locations by distance first, then by full/partial pallet preference
        locations_to_pick.sort(key=lambda x: (x[2], x[1] == 'full'))

        # Pick from the sorted locations based on quantity, but stop when we've picked enough
        for loc, pallet_type, distance in locations_to_pick:
            if remaining_quantity == 0:
                break

            # If this location has more stock than the order quantity remaining
            if loc['quantity'] >= remaining_quantity:
                best_route.append((sku, loc, remaining_quantity, distance))
                loc['quantity'] -= remaining_quantity
                remaining_quantity = 0
            else:
                best_route.append((sku, loc, loc['quantity'], distance))
                remaining_quantity -= loc['quantity']
                loc['quantity'] = 0

    return best_route

# Example Input:

orders = {
    'sku1': 30,  # We need 30 of sku1
    'sku2': 15
}

locations = {
    1: {'rack': 1, 'shelf': 'a', 'bin': 1, 'sku': 'sku1', 'quantity': 12},
    2: {'rack': 10, 'shelf': 'a', 'bin': 2, 'sku': 'sku1', 'quantity': 12},
    3: {'rack': 50, 'shelf': 'a', 'bin': 3, 'sku': 'sku1', 'quantity': 24},  # Very far rack, large distance
    4: {'rack': 2, 'shelf': 'a', 'bin': 4, 'sku': 'sku2', 'quantity': 10},
    5: {'rack': 3, 'shelf': 'b', 'bin': 5, 'sku': 'sku2', 'quantity': 10},
    6: {'rack': 4, 'shelf': 'c', 'bin': 6, 'sku': 'sku2', 'quantity': 10},
    7: {'rack': 5, 'shelf': 'a', 'bin': 7, 'sku': 'sku2', 'quantity': 10}  # Close to other locations for sku2
}

locations_to_highlight = {
    '1-a-1': {'sku': 'sku1', 'quantity': 12},
    '10-a-2': {'sku': 'sku1', 'quantity': 12},
    '50-a-3': {'sku': 'sku1', 'quantity': 24},
    '2-a-4': {'sku': 'sku2', 'quantity': 10},
    '3-b-5': {'sku': 'sku2', 'quantity': 10},
    '4-c-6': {'sku': 'sku2', 'quantity': 10},
    '5-a-7': {'sku': 'sku2', 'quantity': 10}
}

file_path ="C:\\Users\\Owner\\Downloads\\WM warehouse.xlsx"
output_path = "C:\\Users\\Owner\\Downloads\\WM1warehouse.xlsx"
highlight_warehouse(locations_to_highlight, file_path, output_path)
# Call the function
best_route = get_best_route(orders, locations)

# Display the result with SKU and location details
for sku, location, quantity, distance in best_route:
    print(f"Pick {quantity} of SKU '{sku}' from Location {location['rack']}-{location['shelf']}-{location['bin']} (Distance: {distance})")
