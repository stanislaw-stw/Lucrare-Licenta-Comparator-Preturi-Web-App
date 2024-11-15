import sys
import time
import asyncio
import aiohttp
import selenium.common.exceptions
from selenium import webdriver
from selenium.common.exceptions import NoSuchElementException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

driver = webdriver.Chrome()

driver.get("https://www.emag.ro/")


backend_url = "http://localhost:3000/addProduct"  # backend URL


async def send_post_request(session, url, payload, retries=5):
    for attempt in range(retries):
        try:
            print(f"Sending POST request to {url}, attempt {attempt + 1}")
            async with session.post(url, json=payload) as response:
                #trim o cerere POST asincrona catre url(bd( cu payload(Datele care sunt trim in corpul cererii POST) ca date JSON.
                response_text = await response.text()
                if response.status == 201:
                    print("Product added successfully.")
                    return
                else:
                    print(f"Failed to add product: {response_text}")
        except aiohttp.client_exceptions.ServerDisconnectedError as e:
            print(f"Server disconnected: {e}")
            if attempt < retries - 1:
                wait_time = 2 ** attempt
                print(f"Retrying in {wait_time} seconds...")
                await asyncio.sleep(wait_time)
            else:
                print("Max retries reached. Giving up.")
        except Exception as e:
            print(f"Unexpected error: {e}")
            break


async def main(keyword):
    async with aiohttp.ClientSession() as session: # creeaza o sesiune HTTP asincrona cu aiohttp
        try:
            time.sleep(3)
            WebDriverWait(driver, 3).until(
                lambda d: d.execute_script('return document.readyState') == 'complete'
            )
            time.sleep(2)
            search_box = WebDriverWait(driver, 5).until(
                EC.presence_of_element_located((By.ID, "searchboxTrigger"))
            )
            try:
                refuse_all_button = WebDriverWait(driver, 3).until(
                    EC.presence_of_element_located((By.CLASS_NAME, "btn.btn-primary.btn-block.js-refuse.gtm_bxxzbgwexm"))
                )
                refuse_all_button.click()
            except (selenium.common.exceptions.TimeoutException, NoSuchElementException) as e:
                print("Inchis cooke prompt")
            time.sleep(2)
            search_box.click()
            search_box.send_keys(keyword)
            search_box.send_keys(Keys.ENTER)
            time.sleep(3)

            WebDriverWait(driver, 75).until(
                lambda d: d.execute_script('return document.readyState') == 'complete'
            )
            WebDriverWait(driver, 75).until(
                EC.presence_of_element_located((By.CLASS_NAME, "card-item"))
            )

            card_grid_button = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, '[data-target="card_grid"]'))
            )
            card_grid_button.click()
            time.sleep(3)
            WebDriverWait(driver, 75).until(
                lambda d: d.execute_script('return document.readyState') == 'complete'
            )
            WebDriverWait(driver, 75).until(
                EC.presence_of_element_located((By.CLASS_NAME, "card-item"))
            )
            processed_products = set()
            current_page = 1
            max_page = 2
            category = driver.find_element(By.CSS_SELECTOR, ".category-item .category-name").text
            productsFinal = []
            while True:
                # Wait for search results to load
                WebDriverWait(driver, 75).until(
                    EC.presence_of_all_elements_located((By.CLASS_NAME, "card-item"))
                )

                # Extract and log the title and price for each product
                products = driver.find_elements(By.CLASS_NAME, "card-item")
                new_products_found = False #flag pt a urmari daca sunt gasite prod noi

                for product in products:
                    try:
                        product_id = product.get_attribute("data-product-id")
                        if product_id not in processed_products:
                            title = product.find_element(By.CSS_SELECTOR, "[data-zone='title']").text
                            link = product.find_element(By.CSS_SELECTOR, "[data-zone='title']").get_attribute('href')
                            price = product.find_element(By.CLASS_NAME, "product-new-price").text
                            price_str = price.replace(" Lei", "")
                            price_str = price_str.replace(".", "")
                            price_str = price_str.replace(",", ".")
                            price_str = price_str.replace("de la ", "")
                            price_str = price_str.replace(" ", "")
                            price_float = float(price_str)
                            specs = {}
                            try:
                                specs_elements = product.find_elements(By.CSS_SELECTOR,
                                                                       "div.card-body.product-specs-zone p")
                                for idx, spec_element in enumerate(specs_elements, start=1):
                                    spec_label = spec_element.find_element(By.CLASS_NAME, "product-specs-label").text
                                    spec_value = spec_element.text.replace(spec_label, "").strip()
                                    specs[f'spec{idx}'] = f"{spec_label}: {spec_value}" #se adauga in dictionar
                            except NoSuchElementException:
                                specs['spec1'] = "Nu exista specificatie"
                            print("preparing products")
                            image_url = product.find_element(By.CSS_SELECTOR, '.card-list-thumb img').get_attribute(
                                "src")
                            payload = {
                                'title': title,
                                'spec1': link,
                                'spec2': '',
                                'spec3': 'eMag',
                                'spec4': specs.get('spec1', ''),
                                'spec5': specs.get('spec2', ''),
                                'spec6': specs.get('spec3', ''),
                                'spec7': specs.get('spec4', ''),
                                'spec8': specs.get('spec5', ''),
                                'spec9': specs.get('spec6', ''),
                                'spec10': specs.get('spec7', ''),
                                'spec11': specs.get('spec8', ''),
                                'spec12': specs.get('spec9', ''),
                                'spec13': specs.get('spec10', ''),
                                'spec14': specs.get('spec11', ''),
                                'spec15': '',
                                'image_url': image_url,
                                'category': category,
                                'subcategory': keyword,
                                'price': price_float
                            }
                            productsFinal.append(payload)
                            processed_products.add(product_id)
                            new_products_found = True
                    except (NoSuchElementException, selenium.common.exceptions.StaleElementReferenceException):
                        continue

                if not new_products_found:
                    try:
                        refuse_all_button = WebDriverWait(driver, 3).until(
                            EC.presence_of_element_located(
                                (By.CLASS_NAME, "btn.btn-primary.btn-block.js-refuse.gtm_bxxzbgwexm"))
                        )
                        refuse_all_button.click()
                    except (selenium.common.exceptions.TimeoutException, NoSuchElementException) as e:
                        print("No products found.")
                    time.sleep(1)
                    second_last_product = driver.find_elements(By.CLASS_NAME, "card-item")[-2]
                    driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", second_last_product)
                    time.sleep(2) #gaseste penultimul prod si se centreaza cu scrol pe el
                    second_last_product = driver.find_elements(By.CLASS_NAME, "card-item")[-1]
                    driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", second_last_product)
                    time.sleep(1)#gaseste la ultimul prod si se centreaza ca sa gaseasca mai usor butonul de pag
                    next_page_button = None
                    try:
                        next_page_button = driver.find_elements(By.CSS_SELECTOR, "a.js-change-page[aria-label='Next']")
                    except NoSuchElementException: #mai incearca o data sa prinda butonul
                        last_product = driver.find_elements(By.CLASS_NAME, "card-item")[-1]
                        driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", last_product)
                        driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", last_product)
                        WebDriverWait(driver, 10).until(
                            EC.presence_of_element_located((By.CLASS_NAME, "listing-panel-footer"))
                        )

                    if next_page_button and current_page < max_page:
                        current_page += 1
                        next_page_button[0].click()
                        time.sleep(1)
                        WebDriverWait(driver, 75).until(
                            lambda d: d.execute_script('return document.readyState') == 'complete'
                        )
                    else:
                        for product in productsFinal:
                            driver.get(product.get('spec1'))
                            WebDriverWait(driver, 10).until(
                                lambda d: d.execute_script('return document.readyState') == 'complete'
                            )
                            time.sleep(1)
                            try:
                                brand_element = driver.find_element(By.XPATH,
                                                                    "//div[@class='disclaimer-section mrg-sep-sm']/p/a")
                                brand_name = brand_element.text
                            except NoSuchElementException:
                                brand_name = "Brand not found"

                            try:
                                label_in_stock = driver.find_element(By.CLASS_NAME, "label-in_stock").text
                            except NoSuchElementException:
                                try:
                                    label_in_stock = driver.find_element(By.CLASS_NAME, "label-limited_stock_qty").text
                                except NoSuchElementException:
                                    label_in_stock = "Stock label not found"
                            product['spec2'] = label_in_stock
                            product['spec15'] = brand_name
                            await send_post_request(session, backend_url, product)

                        break
        finally:
            driver.quit()


# ruleaza funcția asincrona main cu un argument(un cuv cheie)
#sys.argv este o lista in care primul element (sys.argv[0]) este numele scriptului, iar elementele urm sunt argumentele liniei de comanda
if len(sys.argv) > 1:
    keyword = sys.argv[1]
    asyncio.run(main(keyword))
else:
    print("Please provide a keyword as the first argument.")
