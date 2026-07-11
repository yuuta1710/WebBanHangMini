// 1. NẠP CÁC THƯ VIỆN CẦN THIẾT
//
require('dotenv').config(); // Phải đặt ở đầu tiên để đọc được file .env
 
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const pool = require('./db'); // Kích hoạt kết nối và khởi tạo DB
 
const app = express();
const PORT = process.env.PORT || 5000; // Lấy PORT từ file .env, nếu không có thì dùng 5000
 
// 2. CẤU HÌNH CÁC MIDDLEWARE (Hệ thống xử lý trung gian)
// 
const fs = require('fs');
const path = require('path');
 
// Tạo một luồng ghi file (Write Stream) ở chế độ append (ghi nối tiếp)
const accessLogStream = fs.createWriteStream(
    path.join(__dirname, 'access.log'), 
    { flags: 'a' }
);
 
// 1. Ghi log chi tiết định dạng 'combined' vào file access.log để lưu trữ
app.use(morgan('combined', { stream: accessLogStream }));
 
// 2. Đồng thời in log định dạng ngắn gọn 'dev' ra màn hình console để dễ theo dõi khi code
app.use(morgan('dev'));
 
// ✨ ĐIỀU CHỈNH QUAN TRỌNG: Thêm màng lọc CORS và bộ phân giải dữ liệu JSON từ Client gửi lên
app.use(cors());
app.use(express.json()); 
 
// 3. VIẾT API: LẤY DANH SÁCH SẢN PHẨM (Hỗ trợ cơ bản + Tìm kiếm & Lọc nâng cao)
//
app.get('/api/products', async (req, res) => {
    try {
        // 1. Lấy các tham số lọc từ Query String (?search=...&minPrice=...&maxPrice=...)
        const { search, minPrice, maxPrice } = req.query;
        
        let queryText = 'SELECT * FROM products WHERE 1=1';
        let queryParams = [];
        let paramIndex = 1;
 
        // Nếu có tham số tìm kiếm tên (?search=laptop)
        if (search) {
            queryText += ` AND name ILIKE $${paramIndex}`; // ILIKE giúp tìm kiếm không phân biệt hoa thường
            queryParams.push(`%${search}%`);
            paramIndex++;
        }
 
        // Nếu có tham số lọc giá tối thiểu (?minPrice=1000000)
        if (minPrice) {
            queryText += ` AND price >= $${paramIndex}`;
            queryParams.push(parseInt(minPrice));
            paramIndex++;
        }
 
        // Nếu có tham số lọc giá tối đa (?maxPrice=5000000)
        if (maxPrice) {
            queryText += ` AND price <= $${paramIndex}`;
            queryParams.push(parseInt(maxPrice));
            paramIndex++;
        }
 
        // Luôn sắp xếp theo ID tăng dần để đảm bảo giao diện hiển thị đồng nhất
        queryText += ' ORDER BY id ASC';
 
        // 2. Thực hiện truy vấn vào Database
        const result = await pool.query(queryText, queryParams);
        
        // 3. Kiểm tra nếu kết quả trống (Database trống hoặc không tìm thấy sản phẩm phù hợp)
        if (result.rows.length === 0) {
            return res.status(200).json({
                status: "success",
                message: "Hiện tại chưa có sản phẩm nào trong cửa hàng.",
                data: []
            });
        }
 
        // 4. Trả dữ liệu dạng JSON về cho Frontend
        res.status(200).json({
            status: "success",
            total: result.rows.length,
            data: result.rows // Mảng chứa danh sách các sản phẩm
        });
 
    } catch (err) {
        // ⚠️ BẮT BUỘC: Log lỗi chi tiết ra hệ thống để giám sát (Đáp ứng tiêu chí đề tài) 
        console.error('❌ Lỗi API GET /api/products:', err.message);
        
        // Trả về mã lỗi 500 nếu có sự cố phía Server/Database (Không làm sập ứng dụng)
        res.status(500).json({
            status: "error",
            message: "Lỗi hệ thống. Vui lòng thử lại sau!"
        });
    }
}); 
 
// =========================================================================
// 4. VIẾT API: XỬ LÝ ĐẶT HÀNG & TRỪ KHO TỰ ĐỘNG (POST /api/orders)
// =========================================================================
app.post('/api/orders', async (req, res) => {
    // ✨ ĐIỀU CHỈNH QUAN TRỌNG: Đưa biến client ra ngoài phạm vi để khối finally luôn bắt được và giải phóng kết nối
    let client;
 
    try {
        // 🛡️ LỚP PHÒNG THỦ 1: Chống crash lỗi 500 HTML khi gói tin req.body trống rỗng/mất kết nối dưới tải nặng
        if (!req.body || Object.keys(req.body).length === 0) {
            return res.status(400).json({
                status: "error",
                message: "Không nhận được dữ liệu đơn hàng. Vui lòng kiểm tra lại cấu hình định dạng body JSON!"
            });
        }

        // Tiếp nhận Request body từ Frontend một cách an toàn bên trong khối xử lý lỗi try...catch
        const { customer_name, items } = req.body;
 
        // 🛡️ LỚP PHÒNG THỦ 2: Kiểm tra dữ liệu đầu vào cơ bản (Validation)
        if (!customer_name || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                status: "error",
                message: "Thông tin đơn hàng không hợp lệ. Vui lòng cung cấp tên và danh sách sản phẩm!"
            });
        }
 
        // Sau khi kiểm tra dữ liệu đầu vào thành công mới mượn cổng kết nối kết nối từ Pool
        client = await pool.connect();
 
        // BƯỚC 4.0: Khởi động Giao dịch (Transaction)
        await client.query('BEGIN');
        console.log(`\n=================== 🛒 KHỞI TẠO TRANSACTION ĐƠN HÀNG [Khách: ${customer_name}] ===================`);
 
        let totalPrice = 0;
        const orderSummary = [];
 
        // Duyệt qua từng sản phẩm trong giỏ hàng để kiểm tra kho và tính tiền
        for (const item of items) {
            const { product_id, quantity } = item;
 
            if (!product_id || !quantity || quantity <= 0) {
                throw new Error(`Sản phẩm hoặc số lượng mua không hợp lệ.`);
            }
 
            // BƯỚC 4.1: KIỂM TRA KHO VÀ LOCK DÒNG (FOR UPDATE)
            // Ngăn chặn Race Condition: Nếu có request khác định sửa sản phẩm này, chúng phải xếp hàng đợi COMMIT.
            const productCheck = await client.query(
                'SELECT id, name, price, stock_quantity FROM products WHERE id = $1 FOR UPDATE',
                [product_id]
            );
 
            if (productCheck.rows.length === 0) {
                throw new Error(`Sản phẩm với ID ${product_id} không tồn tại trên hệ thống.`);
            }
 
            const product = productCheck.rows[0];
 
            // BƯỚC 4.2: ĐỐI CHIẾU SỐ LƯỢNG TỒN KHO GIẢ LẬP
            if (product.stock_quantity < quantity) {
                throw new Error(`Sản phẩm [${product.name}] đã hết hàng hoặc không đủ số lượng (Hiện còn: ${product.stock_quantity}, Bạn muốn mua: ${quantity}).`);
            }
 
            // BƯỚC 4.3: TIẾN HÀNH TRỪ KHO TRONG TRANSACTION
            await client.query(
                'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
                [quantity, product_id]
            );
            console.log(`📦 [LOG TRỪ KHO] Sản phẩm: ${product.name} | Đã trừ: ${quantity} | Còn lại: ${product.stock_quantity - quantity}`);
 
            // Tính toán tổng tiền ở Backend (Tuyệt đối không lấy giá tiền từ Frontend truyền lên để tránh bị hack)
            const itemTotalPrice = product.price * quantity;
            totalPrice += itemTotalPrice;
 
            // Lưu thông tin tóm tắt để nạp vào bảng hóa đơn
            orderSummary.push({
                product_id: product.id,
                product_name: product.name,
                price: product.price,
                quantity: quantity,
                subtotal: itemTotalPrice
            });
        }
 
        // BƯỚC 4.4: TẠO ĐƠN HÀNG LƯU VÀO DATABASE
        // Chèn thông tin đơn hàng cùng mảng sản phẩm dạng JSONB vào bảng orders
        const insertOrderQuery = `
            INSERT INTO orders (customer_name, total_price, items) 
            VALUES ($1, $2, $3) 
            RETURNING id, customer_name, total_price, created_at;
        `;
        const orderResult = await client.query(insertOrderQuery, [
            customer_name, 
            totalPrice, 
            JSON.stringify(orderSummary) // Lưu mảng đối tượng dưới dạng chuỗi JSONB
        ]);
 
        // CHỐT GIAO DỊCH: Xác nhận lưu tất cả thay đổi vĩnh viễn xuống DB
        await client.query('COMMIT');
        console.log(`✅ [TRANSACTION SUCCESS] Đơn hàng #${orderResult.rows[0].id} đã chốt thành công.`);
        console.log(`========================================================================================\n`);
 
        // Trả về kết quả thành công dưới dạng JSON đồng nhất cho Frontend hiển thị hóa đơn
        res.status(201).json({
            status: "success",
            message: "Đặt hàng thành công và hệ thống đã cập nhật số lượng tồn kho giả lập!",
            order: orderResult.rows[0]
        });
 
    } catch (err) {
        // HỦY GIAO DỊCH (ROLLBACK): Chỉ thực hiện hủy khi cổng kết nối client đã được mượn thành công
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error(`❌ [TRANSACTION ROLLBACK] Giao dịch thất bại. Lý do:`, err.message);
        console.log(`========================================================================================\n`);
 
        // Phân tách mã lỗi nghiệp vụ (kho hàng -> 400) hoặc lỗi crash hệ thống (-> 500) nhưng LUÔN LUÔN trả về JSON
        const isValidationError = err.message.includes('không tồn tại') || err.message.includes('không đủ số lượng') || err.message.includes('không hợp lệ');

        res.status(isValidationError ? 400 : 500).json({
            status: "error",
            message: err.message || "Xử lý đặt hàng thất bại do sự cố hệ thống dưới tải nặng."
        });
 
    } finally {
        // ⚠️ ĐIỀU KIỆN TIÊN QUYẾT: Giải phóng kết nối trả lại cho Pool quản lý, tránh rò rỉ (Connection Leak)
        if (client) {
            client.release();
        }
    }
});
 
// =========================================================================
// 5. MỞ CỔNG LẮNG NGHE REQUEST
// =========================================================================
app.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`🚀 Server đang chạy thành công tại cổng: ${PORT}`);
    console.log(`🌐 API danh sách sản phẩm: http://localhost:${PORT}/api/products`);
    console.log(`=============================================`);
});