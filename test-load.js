// Kịch bản tự động gửi 30 request đặt hàng đồng thời trong 1 giây
async function runLoadTest() {
    console.log("🚀 [START] Bắt đầu giả lập 30 request đặt hàng ĐỒNG THỜI...");
    const promises = [];
    
    // URL môi trường test
    const BASE_URL = 'http://localhost:5000'; 
    
    for (let i = 1; i <= 30; i++) {
        const requestPromise = fetch(`${BASE_URL}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customer_name: `Khách hàng ảo #${i}`,
                items: [{ "product_id": 1, "quantity": 1 }]
            })
        })
        .then(async (res) => {
            const data = await res.json(); // ✨ CHỈNH SỬA: Luôn parse JSON vì Backend luôn trả về JSON
            
            if (res.ok) {
                console.log(`✉️ Request #${i} | Status: ${res.status} | Phản hồi: ${data.message}`);
            } else {
                // ✨ CHỈNH SỬA: In ra trường message của JSON lỗi một cách gọn gàng
                console.log(`⚠️ Request #${i} | Status: ${res.status} | Lỗi: ${data.message}`);
            }
        })
        .catch((err) => {
            console.log(`❌ Request #${i} | Lỗi kết nối mạng: ${err.message}`);
        });

        promises.push(requestPromise);
    }
    
    await Promise.all(promises);
    console.log("🏁 [END] Đã hoàn thành đợt kiểm thử tải!");
}

runLoadTest();