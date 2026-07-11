// Kịch bản tự động gửi 30 request đặt hàng đồng thời trong 1 giây
async function runLoadTest() {
    console.log("🚀 [START] Bắt đầu giả lập 30 request đặt hàng ĐỒNG THỜI...");
    const promises = [];
    
    // Giả lập sản phẩm ID 1 đang có sẵn trong kho (Ví dụ: còn 5 sản phẩm)
    // Chúng ta gửi 30 request mua, mỗi request mua 1 cái để xem hệ thống xử lý ra sao
    for (let i = 1; i <= 30; i++) {
        const requestPromise = fetch('http://localhost:5000/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customer_name: `Khách hàng ảo #${i}`,
                items: [{ "product_id": 1, "quantity": 1 }]
            })
        })
        .then(async (res) => {
    // Nếu phản hồi thành công (200 hoặc 201) thì mới parse JSON
    if (res.ok) {
        const data = await res.json();
        console.log(`✉️ Request #${i} | Status: ${res.status} | Phản hồi: ${data.message}`);
    } else {
        // Nếu phản hồi lỗi (400, 500...), đọc nó dưới dạng chữ (Text) thay vì JSON
        const errorText = await res.text();
        console.log(`⚠️ Request #${i} | Status: ${res.status} | Nội dung lỗi HTML: ${errorText.substring(0, 200)}`);
    }
})
    }
    
    // Kích hoạt toàn bộ 30 request bắn đi cùng một lúc
    await Promise.all(promises);
    console.log("🏁 [END] Đã hoàn thành đợt kiểm thử tải!");
}

runLoadTest();