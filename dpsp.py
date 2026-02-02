import os

# List your files here relative to the project root
files_to_combine = [
"src/app.js",
"src/adapters/epicor.js",
"src/adapters/hubspot.js",
"src/config/config.js",
"src/config/constants.js",
"src/modules/contacts/index.js",
"src/modules/contacts/repositories/contactRepository.js",
"src/modules/contacts/services/contactServices.js",
"src/modules/customers/index.js",
"src/modules/customers/repositories/customerRepository.js",
"src/modules/customers/services/customerServices.js",
"src/modules/lineItems/index.js",
"src/modules/lineItems/repositories/lineItemRepository.js",
"src/modules/lineItems/services/orderProdMixServices.js",
"src/modules/lineItems/services/qSeatEtabServices.js",
"src/modules/lineItems/services/quoteProdMixServices.js",
"src/modules/orders/index.js",
"src/modules/orders/repositories/orderRepository.js",
"src/modules/orders/services/orderServices.js",
"src/modules/quotes/index.js",
"src/modules/quotes/repositories/quoteRepository.js",
"src/modules/quotes/services/quoteServices.js",
"src/modules/sync/index.js",
"src/modules/sync/repositories/syncRepository.js",
"src/modules/sync/services/syncServices.js",
"src/plugins/backoff.js",
"src/plugins/httpClient.js",
"src/plugins/mongo.js",
"src/schemas/dotenv.json",
"src/schemas/loader.js",
"src/utils/dateHelper.js",
"src/utils/index.js",
]

output_file = "combined_code.txt"

with open(output_file, "w", encoding="utf-8") as out_f:
    for file_path in files_to_combine:
        if os.path.exists(file_path):
            out_f.write(f"/{file_path}:\n")
            with open(file_path, "r", encoding="utf-8") as f:
                out_f.write(f.read())
            out_f.write("\n\n")  # Add spacing between files
        else:
            print(f"Warning: {file_path} does not exist.")

print(f"All files combined into {output_file}")
